"""Inputs for the Pro smallest safe selection (plan 18), gathered on the public side.

- The column lineage snapshot must be lineage_version ≥ 2 (row dependencies) and fresh (built
  from the current target/manifest.json); otherwise there's no pruning and a note says why.
- Models whose SQL differs only in whitespace / Jinja comments (same config and macro code) changed
  no column, without compiling (compiled SQL can differ anyway: is_incremental()).
- Otherwise changed columns per modified model: its compiled SQL now (revisions.compiled_manifest of the
  working copy, into the data dir) vs the state side — the git ref compiled the same way, or for a
  `path:` source the prod manifest's own compiled_code. Anything that can't be compared counts
  as every column changed.
"""

import json
from pathlib import Path

from sqlalchemy import select

from app.db.engine import SessionLocal
from app.db.models import ColumnLineageSnapshot, Project
from app.dbt import slim
from app.dbt.revisions import RevisionError, compiled_manifest
from app.dbt.slim_preview import is_protected, node, resource_type, selector_for
from app.dbt.state import StateDir

MIN_LINEAGE_VERSION = 2
COMPILED_TYPES = frozenset({"model", "snapshot"})
# dbt adapter_type → sqlglot dialect, where the names differ
_DIALECTS = {"sqlserver": "tsql", "fabric": "tsql", "synapse": "tsql", "postgres": "postgres"}


def _loads(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


async def fresh_lineage(project: Project) -> tuple[dict, dict] | None:
    """(lineage, row_deps) from the latest done snapshot, or None when missing / old / stale."""
    async with SessionLocal() as session:
        snap = (await session.execute(
            select(ColumnLineageSnapshot)
            .where(ColumnLineageSnapshot.project_id == project.id, ColumnLineageSnapshot.status == "done")
            .order_by(ColumnLineageSnapshot.id.desc()).limit(1)
        )).scalar_one_or_none()
    if snap is None or (snap.lineage_version or 1) < MIN_LINEAGE_VERSION:
        return None
    try:
        mtime = (Path(project.path) / "target" / "manifest.json").stat().st_mtime
    except OSError:
        return None
    if snap.manifest_mtime != mtime:
        return None
    return _loads(snap.results_json), _loads(snap.row_dependencies_json)


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def dialect_for(manifest: dict) -> str | None:
    adapter = str((manifest.get("metadata") or {}).get("adapter_type") or "").lower()
    return _DIALECTS.get(adapter, adapter or None)


async def _compiled(project: Project, ref: str | None, names: str, notes: list[str], label: str) -> dict:
    try:
        side = await compiled_manifest(project, ref=ref, select=names)
        return json.loads(side.path.read_text(encoding="utf-8"))
    except (RevisionError, OSError, ValueError) as exc:
        message = exc.message if isinstance(exc, RevisionError) else str(exc)
        notes.append(f"Couldn't compile {label} ({message.strip().splitlines()[-1][:300] if message.strip() else 'error'}); "
                     "those models count as entirely changed.")
        return {}


async def changed_columns(
    project: Project, state: StateDir, manifest: dict, changed: list[str], notes: list[str],
) -> dict[str, list[str] | None]:
    result: dict[str, list[str] | None] = {u: None for u in changed}
    state_manifest = _read_json(state.path / "manifest.json")
    compiled = []
    for uid in changed:
        if resource_type(manifest, uid) not in COMPILED_TYPES:
            continue
        # dbt flags any edit to the file; a whitespace / comment edit changes no column
        if slim.logic_unchanged(state_manifest, manifest, uid):
            result[uid] = []
        else:
            compiled.append(uid)
    if not compiled:
        return result
    names = " ".join(sorted({s for s in (selector_for(manifest, u) for u in compiled) if s}))
    head = await _compiled(project, None, names, notes, "the working copy")
    if state.kind == "git":
        base = await _compiled(project, state.sha, names, notes, f"{state.ref}")
    else:
        base = state_manifest
    dialect = dialect_for(manifest)
    for uid in compiled:
        base_sql = node(base, uid).get("compiled_code")
        head_sql = node(head, uid).get("compiled_code")
        result[uid] = slim.changed_columns(base_sql, head_sql, dialect)
    return result


class LineageNeeded(Exception):
    """The lineage snapshot is missing, older than MIN_LINEAGE_VERSION or built from another manifest."""


LINEAGE_NOTE = ("Column lineage is missing or out of date, so the full state selection is shown. "
                "Load column lineage to prune it.")


async def smallest_selection(
    project: Project, state: StateDir, manifest: dict, changed: list[str], candidates: list[str], notes: list[str],
) -> dict:
    """wickd_pro.slim_selection.prune's result. Raises LineageNeeded when it can't run safely."""
    lineage = await fresh_lineage(project)
    if lineage is None:
        raise LineageNeeded(LINEAGE_NOTE)
    columns = await changed_columns(project, state, manifest, changed, notes)
    kinds = {uid: resource_type(manifest, uid) for uid in candidates}
    parents = {uid: list(ps) for uid, ps in (manifest.get("parent_map") or {}).items()}
    protected = {uid for uid in changed if is_protected(manifest, uid)}
    return slim.prune(kinds, columns, lineage[0], lineage[1], parents, protected)
