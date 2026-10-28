"""The MetricFlow sidecar venv: `<data_dir>/metricflow-venv` with only the pinned engine.

It never contains dbt and is never imported into the backend process (MetricFlow pulls
a newer sqlglot than the backend allows). worker_main.py runs inside it. The venv
records the engine pin and interpreter it was built with in MARKER_NAME and is rebuilt
when either changes, like the dbt venv's `.wickd-python`.
"""

import json
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.dbt import venv as dbt_venv
from app.logging_setup import get_logger

log = get_logger(__name__)

# Bump on purpose at release time, after rerunning the metricflow-bench kit
# (wickd-pro/docs/plans/research/metricflow-bench). Apache-2.0 engines only (>= 0.209).
ENGINE_VERSION = "0.213.0"
ENGINE_REQUIREMENT = f"metricflow=={ENGINE_VERSION}"
# requires_python of the pinned engine
PYTHON_MIN = (3, 10)
PYTHON_MAX = (3, 14)
MARKER_NAME = ".wickd-metricflow"
INSTALL_TIMEOUT_S = 15 * 60
# The first import after an install compiles bytecode (10–20 s); do it during setup.
WARMUP_IMPORT = "import metricflow.engine.metricflow_engine, metricflow_semantics.model.dbt_manifest_parser"

Progress = Callable[[str, str], None]  # (phase, message)


class SidecarUnavailable(Exception):
    """The sidecar venv can't be built (no suitable Python, pip failed, offline …)."""


@dataclass(frozen=True)
class SidecarStatus:
    state: str  # missing | stale | ready
    engine_version: str
    python: str | None


def venv_dir() -> Path:
    return settings.metricflow_venv_dir or settings.data_dir / "metricflow-venv"


def venv_python() -> Path:
    return venv_dir() / "bin" / "python"


def _read_marker() -> dict | None:
    try:
        data = json.loads((venv_dir() / MARKER_NAME).read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _python_ok(path: str) -> bool:
    version = dbt_venv._python_version(path)
    return version is not None and PYTHON_MIN <= version <= PYTHON_MAX


def choose_python() -> str:
    """The configured `python_path` if the engine supports it, else the newest that does."""
    configured = dbt_venv.configured_python()
    if configured and _python_ok(configured):
        return configured
    for interpreter in dbt_venv.list_pythons():
        if _python_ok(interpreter.path):
            return interpreter.path
    raise SidecarUnavailable(
        f"MetricFlow {ENGINE_VERSION} needs Python {PYTHON_MIN[0]}.{PYTHON_MIN[1]}–"
        f"{PYTHON_MAX[0]}.{PYTHON_MAX[1]}, and none was found."
    )


def status() -> SidecarStatus:
    marker = _read_marker()
    if marker is None or not venv_python().exists():
        return SidecarStatus("missing", ENGINE_VERSION, None)
    python = marker.get("python")
    if marker.get("engine") != ENGINE_VERSION or not isinstance(python, str) or not Path(python).exists():
        return SidecarStatus("stale", ENGINE_VERSION, python if isinstance(python, str) else None)
    return SidecarStatus("ready", ENGINE_VERSION, python)


def _run(args: list[str], what: str) -> None:
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=INSTALL_TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SidecarUnavailable(f"{what} failed: {exc}") from exc
    if result.returncode != 0:
        tail = "\n".join((result.stderr or result.stdout).strip().splitlines()[-8:])
        log.warning("metricflow_sidecar_step_failed", step=what, output=tail)
        raise SidecarUnavailable(f"{what} failed:\n{tail}")


def ensure_sidecar(progress: Progress | None = None) -> Path:
    """Build or rebuild the sidecar venv if needed; return its Python. Blocking — run in a thread."""
    notify = progress or (lambda phase, message: None)
    if status().state == "ready":
        return venv_python()
    python = choose_python()
    target = venv_dir()
    log.info("metricflow_sidecar_building", python=python, venv_dir=str(target), engine=ENGINE_VERSION)
    notify("creating", f"Creating the MetricFlow environment with {python}")
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        _run([python, "-m", "venv", str(target)], "Creating the MetricFlow venv")
        notify("installing", f"Installing {ENGINE_REQUIREMENT}")
        _run(
            [str(venv_python()), "-m", "pip", "install", "--disable-pip-version-check", "-q", ENGINE_REQUIREMENT],
            f"pip install {ENGINE_REQUIREMENT}",
        )
        notify("warming", "Preparing MetricFlow (first start compiles it)")
        _run([str(venv_python()), "-I", "-c", WARMUP_IMPORT], "Importing MetricFlow")
    except SidecarUnavailable:
        shutil.rmtree(target, ignore_errors=True)
        raise
    (target / MARKER_NAME).write_text(json.dumps({"engine": ENGINE_VERSION, "python": python}))
    log.info("metricflow_sidecar_ready", venv_dir=str(target))
    notify("ready", f"MetricFlow {ENGINE_VERSION} is ready")
    return venv_python()
