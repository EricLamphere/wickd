"""The dbt Charts sidecar venv: `<data_dir>/dbt-charts-venv` with the pinned `dbt-charts` (the `dct` CLI).

dbt-charts brings its own dbt-core (<2), dbt-adapters and dbt-duckdb, so it lives in neither
the backend venv nor the user's dbt venv. Warehouses other than DuckDB need the matching extra
(`dbt-charts[snowflake]` …): the venv is shared by every project and the extras accumulate —
a project on a new adapter adds its extra with one more `pip install`, no rebuild. The marker
records the pin, interpreter and installed extras; a different pin or a vanished interpreter
rebuilds from scratch.
"""

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

import yaml

from app import sidecar as shared
from app.config import settings
from app.logging_setup import get_logger

log = get_logger(__name__)

# Bump on purpose: dbt Charts is pre-1.0 and its board format still changes between minors.
# Verified against 0.10.0 (wickd-pro/docs/plans/research/dbt-charts-2026-11-03.md).
DCT_VERSION = "0.10.0"
PACKAGE = "dbt-charts"
PYTHON_MIN = (3, 11)  # requires_python of the pin: >=3.11,<3.14
PYTHON_MAX = (3, 13)
MARKER_NAME = ".wickd-dbt-charts"

# dbt adapter type (profiles.yml `type:`) → dbt-charts extra. DuckDB is in the base install.
ADAPTER_EXTRAS: dict[str, str] = {
    "athena": "athena", "bigquery": "bigquery", "clickhouse": "clickhouse", "databricks": "databricks",
    "fabric": "fabric", "postgres": "postgresql", "redshift": "redshift", "snowflake": "snowflake",
    "spark": "spark", "sqlserver": "sqlserver", "trino": "trino",
}
BASE_ADAPTERS = frozenset({"duckdb"})

Progress = shared.Progress
SidecarUnavailable = shared.SidecarUnavailable


@dataclass(frozen=True)
class SidecarStatus:
    state: str  # missing | stale | needs_extra | ready
    version: str
    python: str | None
    extras: tuple[str, ...] = ()


def venv_dir() -> Path:
    return settings.data_dir / "dbt-charts-venv"


def venv_bin(name: str) -> Path:
    return venv_dir() / "bin" / name


def dct_path() -> Path:
    return venv_bin("dct")


def extra_for(adapter_type: str | None) -> str | None:
    """The extra a project's adapter needs; None for DuckDB / unknown (nothing extra to install)."""
    return ADAPTER_EXTRAS.get((adapter_type or "").lower())


def unsupported_adapter(adapter_type: str | None) -> bool:
    kind = (adapter_type or "").lower()
    return bool(kind) and kind not in ADAPTER_EXTRAS and kind not in BASE_ADAPTERS


def status(extra: str | None = None) -> SidecarStatus:
    marker = shared.read_marker(venv_dir(), MARKER_NAME)
    if marker is None or not dct_path().exists():
        return SidecarStatus("missing", DCT_VERSION, None)
    python = marker.get("python") if isinstance(marker.get("python"), str) else None
    extras = tuple(e for e in marker.get("extras") or [] if isinstance(e, str))
    if marker.get("version") != DCT_VERSION or python is None or not Path(python).exists():
        return SidecarStatus("stale", DCT_VERSION, python, extras)
    if extra and extra not in extras:
        return SidecarStatus("needs_extra", DCT_VERSION, python, extras)
    return SidecarStatus("ready", DCT_VERSION, python, extras)


def requirement(extras: tuple[str, ...]) -> str:
    return f"{PACKAGE}[{','.join(sorted(extras))}]=={DCT_VERSION}" if extras else f"{PACKAGE}=={DCT_VERSION}"


def _pip_install(extras: tuple[str, ...], notify: Progress) -> None:
    req = requirement(extras)
    notify("installing", f"Installing {req}")
    shared.run_step(
        [str(venv_bin("python")), "-m", "pip", "install", "--disable-pip-version-check", "-q", req], f"pip install {req}"
    )


def ensure_sidecar(extra: str | None = None, progress: Progress | None = None) -> Path:
    """Build the venv (or add `extra` to it) if needed; return the `dct` path. Blocking — run in a thread."""
    notify = progress or (lambda phase, message: None)
    current = status(extra)
    if current.state == "ready":
        return dct_path()
    target = venv_dir()
    if current.state == "needs_extra":
        assert current.python is not None
        extras = tuple(sorted({*current.extras, *([extra] if extra else [])}))
        _pip_install(extras, notify)
        shared.write_marker(target, MARKER_NAME, {"version": DCT_VERSION, "python": current.python, "extras": list(extras)})
        notify("ready", f"dbt Charts {DCT_VERSION} is ready")
        return dct_path()
    python = shared.choose_python(PYTHON_MIN, PYTHON_MAX, f"dbt Charts {DCT_VERSION}")
    extras = tuple(sorted({*current.extras, *([extra] if extra else [])}))
    log.info("dbt_charts_sidecar_building", python=python, venv_dir=str(target), version=DCT_VERSION, extras=extras)
    notify("creating", f"Creating the dbt Charts environment with {python}")
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        shared.run_step([python, "-m", "venv", str(target)], "Creating the dbt Charts venv")
        _pip_install(extras, notify)
        notify("warming", "Preparing dbt Charts (first start compiles it)")
        shared.run_step([str(dct_path()), "--version"], "Starting dct")
    except SidecarUnavailable:
        shutil.rmtree(target, ignore_errors=True)
        raise
    shared.write_marker(target, MARKER_NAME, {"version": DCT_VERSION, "python": python, "extras": list(extras)})
    log.info("dbt_charts_sidecar_ready", venv_dir=str(target))
    notify("ready", f"dbt Charts {DCT_VERSION} is ready")
    return dct_path()


# ── the project's adapter (for the extra) ──────────────────────────────────────


def _profiles(project_path: Path, env: dict[str, str]) -> dict:
    candidates = [project_path / "profiles.yml"]
    if env.get("DBT_PROFILES_DIR"):
        candidates.append(Path(env["DBT_PROFILES_DIR"]).expanduser() / "profiles.yml")
    candidates.append(Path.home() / ".dbt" / "profiles.yml")
    for path in candidates:
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(data, dict):
            return data
    return {}


def _profile_name(project_path: Path) -> str | None:
    try:
        data = yaml.safe_load((project_path / "dbt_project.yml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    name = data.get("profile") if isinstance(data, dict) else None
    return name if isinstance(name, str) else None


def adapter_type(project_path: Path, env: dict[str, str] | None = None) -> str | None:
    """The adapter `type:` of the project's profile for DBT_TARGET (else the profile's default target)."""
    env = env if env is not None else dict(os.environ)
    profile = _profiles(project_path, env).get(env.get("DBT_PROFILE") or _profile_name(project_path) or "")
    if not isinstance(profile, dict):
        return None
    outputs = profile.get("outputs") if isinstance(profile.get("outputs"), dict) else {}
    output = outputs.get(env.get("DBT_TARGET") or profile.get("target") or "")
    kind = output.get("type") if isinstance(output, dict) else None
    return kind if isinstance(kind, str) else None
