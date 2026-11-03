"""Relation names of nodes on another dbt target, without a warehouse connection.

The working copy is parsed for that target by revisions.side_manifest() (`dbt parse --target …
--target-path <data_dir>/compare/<id>/targets/working-<target>/`); that folder's manifest.json
has every node's `relation_name` as the target would build it. Ephemeral models have none.
Cached per (project, target) while the project's own manifest.json is unchanged.
"""

import asyncio
import json
from pathlib import Path

from app.db.models import Project
from app.dbt.revisions import side_manifest

_cache: dict[tuple[int, str], tuple[float, dict]] = {}


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def relations_from_manifest(manifest: dict, unique_ids: list[str]) -> dict[str, str | None]:
    nodes = manifest.get("nodes") or {}
    return {uid: (nodes.get(uid) or {}).get("relation_name") or None for uid in unique_ids}


def _project_manifest_mtime(project: Project) -> float:
    try:
        return (Path(project.path) / "target" / "manifest.json").stat().st_mtime
    except OSError:
        return 0.0


async def manifest_for_target(project: Project, target: str) -> dict:
    """The working copy's manifest as `target` would build it (raises revisions.RevisionError)."""
    stamp = _project_manifest_mtime(project)
    cached = _cache.get((project.id, target))
    if cached and cached[0] == stamp and stamp:
        return cached[1]
    side = await side_manifest(project, ref=None, target=target)
    manifest = await asyncio.to_thread(_read, side.path.parent / "manifest.json")
    _cache[(project.id, target)] = (stamp, manifest)
    return manifest


async def relations_for_target(project: Project, target: str, unique_ids: list[str]) -> dict[str, str | None]:
    return relations_from_manifest(await manifest_for_target(project, target), unique_ids)
