"""The saved column lineage snapshot every lineage feature reads, and whether it's out of date.

The latest *done* snapshot is the cache: a refresh in progress (or one that failed) never hides it.
Whether it's out of date comes from app/dbt/lineage_freshness.py (content, not manifest mtime).
"""

import asyncio
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ColumnLineageSnapshot
from app.dbt import column_lineage
from app.dbt.lineage_freshness import current_fingerprint, stale_reason, tracer_key


def manifest_path(project_path: str | Path) -> Path:
    return Path(project_path) / "target" / "manifest.json"


def current_tracer() -> str:
    return tracer_key(column_lineage.current_lineage_version())


async def latest_snapshot(session: AsyncSession, project_id: int) -> ColumnLineageSnapshot | None:
    """The newest snapshot in any status (a refresh may be running or have failed)."""
    result = await session.execute(
        select(ColumnLineageSnapshot)
        .where(ColumnLineageSnapshot.project_id == project_id)
        .order_by(ColumnLineageSnapshot.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def latest_done(session: AsyncSession, project_id: int) -> ColumnLineageSnapshot | None:
    """The cache: the newest finished snapshot."""
    result = await session.execute(
        select(ColumnLineageSnapshot)
        .where(ColumnLineageSnapshot.project_id == project_id, ColumnLineageSnapshot.status == "done")
        .order_by(ColumnLineageSnapshot.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def staleness(project_path: str | Path, snap: ColumnLineageSnapshot) -> str | None:
    """Why `snap` no longer matches the project's manifest, or None if it's current.
    A missing or unreadable manifest can't prove it stale, so it counts as current."""
    fingerprint = await asyncio.to_thread(current_fingerprint, manifest_path(project_path))
    if fingerprint is None:
        return None
    return stale_reason(snap.fingerprint_json, fingerprint, current_tracer())


async def usable_snapshot(
    session: AsyncSession, project_id: int, min_version: int,
) -> tuple[ColumnLineageSnapshot | None, str | None]:
    """(the cache, None) when a finished snapshot of at least `min_version` exists; otherwise
    (None, reason) with reason missing / running / error / outdated. A refresh in progress
    doesn't hide the cache."""
    cached = await latest_done(session, project_id)
    if cached is not None and (cached.lineage_version or 1) >= min_version:
        return cached, None
    newest = await latest_snapshot(session, project_id)
    if newest is not None and newest.status == "running":
        return None, "running"
    if cached is not None:
        return None, "outdated"
    return None, "missing" if newest is None else "error"
