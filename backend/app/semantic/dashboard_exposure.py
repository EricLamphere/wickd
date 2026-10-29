"""Register a dashboard as a dbt exposure (`type: dashboard`, depends_on its widgets' metrics).

The file is the project's existing exposures file, else `<first model path>/exposures.yml`.
The dashboard then shows up in the DAG, Impact and Docs like any downstream consumer.
Writing the YAML triggers the watcher → autoparse → `graph_changed`.
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from app.dbt.schema_exposures import ExposureSpec, add_exposure
from app.dbt.schema_yaml import YAML_SUFFIXES, SchemaYamlError, _read, _write
from app.semantic.dashboards import Dashboard
from app.semantic.service import target_dir

DEFAULT_FILE = "exposures.yml"


@dataclass(frozen=True)
class ExposureWrite:
    path: str  # relative to the project root (posix)
    text: str


def exposure_name(slug: str) -> str:
    name = slug.replace("-", "_")
    return name if name[:1].isalpha() or name[:1] == "_" else f"dashboard_{name}"


def dashboard_metrics(dashboard: Dashboard, catalog: Mapping[str, Any]) -> tuple[str, ...]:
    """Every metric the widgets show, in widget order (unknown ones left out)."""
    known = {m.get("name") for m in catalog.get("metrics") or []}
    found = [m for widget in dashboard.widgets for m in widget.metrics if m in known]
    return tuple(dict.fromkeys(found))


def _model_dir(project_path: Path) -> str:
    try:
        data = yaml.safe_load((project_path / "dbt_project.yml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        data = None
    paths = data.get("model-paths") if isinstance(data, dict) else None
    first = next((p for p in paths if isinstance(p, str) and p.strip("/")), None) if isinstance(paths, list) else None
    return (first or "models").strip("/")


def choose_file(project_path: Path, manifest: Mapping[str, Any]) -> str:
    project_name = (manifest.get("metadata") or {}).get("project_name")
    existing = sorted(
        n["original_file_path"] for n in (manifest.get("exposures") or {}).values()
        if isinstance(n, dict) and str(n.get("original_file_path", "")).endswith(YAML_SUFFIXES)
        and (project_name is None or n.get("package_name") == project_name)
    )
    return existing[0] if existing else f"{_model_dir(project_path)}/{DEFAULT_FILE}"


def _manifest(project_path: Path) -> dict[str, Any]:
    try:
        return json.loads((target_dir(project_path) / "manifest.json").read_text())
    except (OSError, ValueError) as exc:
        raise SchemaYamlError("no manifest yet — run dbt parse first") from exc


def plan_register(project_path: Path, spec: ExposureSpec) -> ExposureWrite:
    manifest = _manifest(project_path)
    taken = {n.get("name") for n in (manifest.get("exposures") or {}).values() if isinstance(n, dict)}
    if spec.name in taken:
        raise SchemaYamlError(f"there's already an exposure named `{spec.name}`")
    relative = choose_file(project_path, manifest)
    root = project_path.resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise SchemaYamlError(f"{relative} is outside the project")
    text = _read(path) if path.exists() else ""
    return ExposureWrite(path=Path(relative).as_posix(), text=add_exposure(text, path.name, spec))


def register(project_path: Path, spec: ExposureSpec) -> str:
    planned = plan_register(project_path, spec)
    _write(project_path / planned.path, planned.text)
    return planned.path
