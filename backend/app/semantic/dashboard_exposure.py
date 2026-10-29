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
class ExposureIndex:
    """From dbt's manifest: the exposures by name, and every metric's name."""

    exposures: dict[str, dict[str, Any]]  # name → {unique_id, path, metrics}
    metrics: frozenset[str]


# (manifest path, mtime_ns, size) → the index; rebuilt when dbt re-parses
_index_cache: dict[tuple[str, int, int], ExposureIndex] = {}


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


def project_exposures(project_path: Path) -> ExposureIndex | None:
    """The project's exposures (with the metrics they depend on) and metric names, or None without a manifest."""
    manifest_path = target_dir(project_path) / "manifest.json"
    try:
        stat = manifest_path.stat()
    except OSError:
        return None
    key = (str(manifest_path), stat.st_mtime_ns, stat.st_size)
    if key not in _index_cache:
        try:
            manifest = json.loads(manifest_path.read_text())
        except (OSError, ValueError):
            return None
        metric_names = {uid: m.get("name") for uid, m in (manifest.get("metrics") or {}).items() if isinstance(m, dict)}
        exposures = {}
        for uid, n in (manifest.get("exposures") or {}).items():
            if not isinstance(n, dict) or not n.get("name"):
                continue
            nodes = (n.get("depends_on") or {}).get("nodes") or []
            exposures[n["name"]] = {
                "unique_id": uid, "path": str(n.get("original_file_path") or ""),
                "metrics": [metric_names[d] for d in nodes if metric_names.get(d)],
            }
        _index_cache.clear()  # one project's manifest at a time is plenty
        _index_cache[key] = ExposureIndex(exposures=exposures, metrics=frozenset(n for n in metric_names.values() if n))
    return _index_cache[key]


def exposure_drift(dashboard: Dashboard, linked: dict[str, Any], known_metrics: frozenset[str]) -> dict[str, list[str]]:
    """Metrics on the dashboard that the exposure doesn't list (`add`) and ones it lists that
    the dashboard no longer shows (`remove`). Metrics that don't exist (any more) are ignored."""
    shown = list(dict.fromkeys(m for w in dashboard.widgets for m in w.metrics if m in known_metrics))
    listed = list(linked.get("metrics") or [])
    return {"add": [m for m in shown if m not in listed], "remove": [m for m in listed if m not in shown]}


def dashboard_metric_names(dashboard: Dashboard, known_metrics: frozenset[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(m for w in dashboard.widgets for m in w.metrics if m in known_metrics))


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
