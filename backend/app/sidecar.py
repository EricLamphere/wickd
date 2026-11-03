"""Helpers shared by the sidecar venvs (MetricFlow in app/semantic/sidecar_env.py, dbt Charts
in app/charts/sidecar_env.py): tools kept out of both the backend venv and the dbt venv because
their dependencies clash with one or the other.

Each sidecar is a venv under the data dir with a JSON marker file recording what it was built
with (pin, interpreter, …); it's rebuilt when the marker no longer matches.
"""

import json
import subprocess
from collections.abc import Callable
from pathlib import Path

from app.dbt import venv as dbt_venv
from app.logging_setup import get_logger

log = get_logger(__name__)

Progress = Callable[[str, str], None]  # (phase, message)
INSTALL_TIMEOUT_S = 15 * 60
OUTPUT_TAIL_LINES = 8


class SidecarUnavailable(Exception):
    """A sidecar venv can't be built (no suitable Python, pip failed, offline …)."""


def python_in_range(path: str, low: tuple[int, int], high: tuple[int, int]) -> bool:
    version = dbt_venv._python_version(path)
    return version is not None and low <= version <= high


def choose_python(low: tuple[int, int], high: tuple[int, int], tool: str) -> str:
    """The configured `python_path` if it's in [low, high], else the newest installed one that is."""
    configured = dbt_venv.configured_python()
    if configured and python_in_range(configured, low, high):
        return configured
    for interpreter in dbt_venv.list_pythons():
        if python_in_range(interpreter.path, low, high):
            return interpreter.path
    raise SidecarUnavailable(
        f"{tool} needs Python {low[0]}.{low[1]}–{high[0]}.{high[1]}, and none was found."
    )


def run_step(args: list[str], what: str, *, timeout: float = INSTALL_TIMEOUT_S) -> None:
    """Run one setup command (venv creation, pip install …); SidecarUnavailable with its output tail on failure."""
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SidecarUnavailable(f"{what} failed: {exc}") from exc
    if result.returncode != 0:
        tail = "\n".join((result.stderr or result.stdout).strip().splitlines()[-OUTPUT_TAIL_LINES:])
        log.warning("sidecar_step_failed", step=what, output=tail)
        raise SidecarUnavailable(f"{what} failed:\n{tail}")


def read_marker(venv: Path, name: str) -> dict | None:
    try:
        data = json.loads((venv / name).read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def write_marker(venv: Path, name: str, data: dict) -> None:
    (venv / name).write_text(json.dumps(data))
