"""The MetricFlow sidecar venv: `<data_dir>/metricflow-venv` with only the pinned engine.

It never contains dbt and is never imported into the backend process (MetricFlow pulls
a newer sqlglot than the backend allows). worker_main.py runs inside it. The venv
records the engine pin and interpreter it was built with in MARKER_NAME and is rebuilt
when either changes, like the dbt venv's `.wickd-python`.
"""

import shutil
from dataclasses import dataclass
from pathlib import Path

from app import sidecar as shared
from app.config import settings
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

Progress = shared.Progress


# The sidecar venv can't be built (no suitable Python, pip failed, offline …)
SidecarUnavailable = shared.SidecarUnavailable


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
    return shared.read_marker(venv_dir(), MARKER_NAME)


def choose_python() -> str:
    """The configured `python_path` if the engine supports it, else the newest that does."""
    return shared.choose_python(PYTHON_MIN, PYTHON_MAX, f"MetricFlow {ENGINE_VERSION}")


def status() -> SidecarStatus:
    marker = _read_marker()
    if marker is None or not venv_python().exists():
        return SidecarStatus("missing", ENGINE_VERSION, None)
    python = marker.get("python")
    if marker.get("engine") != ENGINE_VERSION or not isinstance(python, str) or not Path(python).exists():
        return SidecarStatus("stale", ENGINE_VERSION, python if isinstance(python, str) else None)
    return SidecarStatus("ready", ENGINE_VERSION, python)


def _run(args: list[str], what: str) -> None:
    shared.run_step(args, what, timeout=INSTALL_TIMEOUT_S)


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
    shared.write_marker(target, MARKER_NAME, {"engine": ENGINE_VERSION, "python": python})
    log.info("metricflow_sidecar_ready", venv_dir=str(target))
    notify("ready", f"MetricFlow {ENGINE_VERSION} is ready")
    return venv_python()
