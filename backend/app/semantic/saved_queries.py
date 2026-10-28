"""Save an explorer query as a dbt saved query (YAML), see dbt/schema_saved_queries.py.

The target file is the project's existing saved-queries file, else the YAML that
defines the query's first metric. Writing it triggers the watcher → autoparse →
`graph_changed`, which refreshes the catalog.
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from app.dbt.schema_saved_queries import SavedQuerySpec, add_saved_query, group_by_template
from app.dbt.schema_yaml import YAML_SUFFIXES, SchemaYamlError, _read, _write
from app.semantic.service import target_dir


@dataclass(frozen=True)
class SavedQueryWrite:
    path: str  # relative to the project root (posix)
    text: str


def _root_files(nodes: Mapping[str, Any], project_name: str | None) -> list[str]:
    return sorted(
        n["original_file_path"] for n in nodes.values()
        if isinstance(n, dict) and n.get("original_file_path", "").endswith(YAML_SUFFIXES)
        and (project_name is None or n.get("package_name") == project_name)
    )


def choose_file(manifest: Mapping[str, Any], metrics: Sequence[str]) -> str:
    """The YAML path (project-relative) a new saved query for `metrics` belongs in."""
    project_name = (manifest.get("metadata") or {}).get("project_name")
    existing = _root_files(manifest.get("saved_queries") or {}, project_name)
    if existing:
        return existing[0]
    by_name = {
        n.get("name"): n for n in (manifest.get("metrics") or {}).values()
        if isinstance(n, dict) and (project_name is None or n.get("package_name") == project_name)
    }
    first = by_name.get(metrics[0]) if metrics else None
    path = (first or {}).get("original_file_path", "")
    if not path.endswith(YAML_SUFFIXES):
        raise SchemaYamlError(f"couldn't find the YAML file that defines `{metrics[0] if metrics else '?'}`")
    return path


def date_filters(start: str | None, end: str | None) -> list[str]:
    """Saved queries have no time constraint: a date range becomes metric_time filters."""
    for value in (start, end):
        if value:
            try:
                date.fromisoformat(value[:10])
            except ValueError:
                raise SchemaYamlError(f"`{value}` isn't an ISO date") from None
    start, end = (start or "")[:10], (end or "")[:10]
    day = "{{ TimeDimension('metric_time', 'day') }}"
    return ([f"{day} >= '{start}'"] if start else []) + ([f"{day} <= '{end}'"] if end else [])


def spec_for(query: Mapping[str, Any], catalog: Mapping[str, Any]) -> SavedQuerySpec:
    metrics = list(query.get("metrics") or [])
    dimension_types = {
        d["name"]: d.get("type") or ""
        for m in catalog.get("metrics", []) if m.get("name") in metrics
        for d in m.get("dimensions", [])
    }
    return SavedQuerySpec(
        name=query["name"],
        label=query.get("label") or None,
        description=query.get("description") or None,
        metrics=tuple(metrics),
        group_by=tuple(group_by_template(g, dimension_types) for g in query.get("group_by") or []),
        where=(*(query.get("where") or []), *date_filters(query.get("start"), query.get("end"))),
    )


def plan_save(project_path: Path, spec: SavedQuerySpec) -> SavedQueryWrite:
    manifest_path = target_dir(project_path) / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as exc:
        raise SchemaYamlError("no manifest yet — run dbt parse first") from exc
    relative = choose_file(manifest, spec.metrics)
    path = (project_path / relative).resolve()
    if not path.is_relative_to(project_path.resolve()):
        raise SchemaYamlError(f"{relative} is outside the project")
    return SavedQueryWrite(path=Path(relative).as_posix(), text=add_saved_query(_read(path), path.name, spec))


def save(project_path: Path, spec: SavedQuerySpec) -> str:
    planned = plan_save(project_path, spec)
    _write(project_path / planned.path, planned.text)
    return planned.path
