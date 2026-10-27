"""Ranked test targets from the latest column lineage snapshot (wickd Pro).

Needs a done snapshot with join pairs and grain (lineage_version 4); anything
else raises LineageNotReady with why — missing / running / error / outdated —
which the API turns into 409 and the UI into a "Refresh column lineage" prompt.

The project-wide ranking walks the whole lineage, so it's cached per project
for the snapshot id and the manifest's mtime (tests added since change the
result). One model's ranking is cheap and not cached.
"""

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.documentation import load_manifest_dict
from app.ai.errors import ProposalError
from app.db.models import ColumnLineageSnapshot
from app.logging_setup import get_logger
from app.test_targets import pro

log = get_logger(__name__)

STRUCTURE_LINEAGE_VERSION = 4


class LineageNotReady(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason  # missing | running | error | outdated


@dataclass(frozen=True)
class LineageInputs:
    snapshot_id: int
    lineage: dict
    row_deps: dict
    structure: dict


def _loads(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


async def latest_inputs(session: AsyncSession, project_id: int) -> LineageInputs:
    result = await session.execute(
        select(ColumnLineageSnapshot)
        .where(ColumnLineageSnapshot.project_id == project_id)
        .order_by(ColumnLineageSnapshot.id.desc())
        .limit(1)
    )
    snap = result.scalar_one_or_none()
    if snap is None:
        raise LineageNotReady("missing")
    if snap.status == "running":
        raise LineageNotReady("running")
    if snap.status != "done":
        raise LineageNotReady("error")
    if (snap.lineage_version or 1) < STRUCTURE_LINEAGE_VERSION:
        raise LineageNotReady("outdated")
    return LineageInputs(
        snapshot_id=snap.id,
        lineage=_loads(snap.results_json),
        row_deps=_loads(snap.row_dependencies_json),
        structure=_loads(snap.join_keys_json),
    )


_cache: dict[int, tuple[tuple[int, str, float], list[dict]]] = {}


def _manifest_mtime(project_path: Path) -> float:
    try:
        return (project_path / "target" / "manifest.json").stat().st_mtime
    except OSError:
        return 0.0


def project_ranking(project_id: int, project_path: Path, inputs: LineageInputs) -> list[dict]:
    """Every column with a suggested test, highest score first. Sync (run in a thread)."""
    key = (inputs.snapshot_id, str(project_path), _manifest_mtime(project_path))
    cached = _cache.get(project_id)
    if cached is not None and cached[0] == key:
        return cached[1]
    manifest = load_manifest_dict(project_path)
    rows = pro.rank_test_targets(manifest, inputs.lineage, inputs.row_deps, inputs.structure)
    _cache[project_id] = (key, rows)
    return rows


def model_ranking(manifest: dict, inputs: LineageInputs, unique_id: str) -> list[dict]:
    """One model's columns, ranked, with candidates where there's evidence."""
    return pro.rank_test_targets(manifest, inputs.lineage, inputs.row_deps, inputs.structure, [unique_id])


async def targets_for_model(project_id: int, project_path: Path, unique_id: str) -> list[dict] | None:
    """The model's ranking for test generation, or None when lineage isn't ready
    or this build can't rank (suggestions then come from the AI model alone)."""
    from app.db import engine as db_engine  # patched in tests, like other background readers

    if not pro.is_available():
        return None
    try:
        async with db_engine.SessionLocal() as session:
            inputs = await latest_inputs(session, project_id)
        manifest = await asyncio.to_thread(load_manifest_dict, project_path)
        return await asyncio.to_thread(model_ranking, manifest, inputs, unique_id)
    except LineageNotReady as exc:
        log.info("test_targets_lineage_not_ready", project_id=project_id, reason=exc.reason)
    except ProposalError as exc:
        log.info("test_targets_unavailable", project_id=project_id, error=str(exc))
    return None
