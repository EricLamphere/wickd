import asyncio
import time
from collections.abc import Awaitable
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AppSetting, Project
from app.projects.discovery import DiscoveredProject, discover_projects
from app.config import settings
from app.logging_setup import get_logger

log = get_logger(__name__)

# The startup rescan runs in the background so the server answers requests
# (and the UI leaves its loading screen) while a large workspace is walked.
# Endpoints that return the project list await it via wait_for_startup_scan().
_startup_scan: asyncio.Task[None] | None = None


def begin_startup_scan(scan: Awaitable[None]) -> None:
    global _startup_scan
    _startup_scan = asyncio.ensure_future(scan)


async def wait_for_startup_scan() -> None:
    task = _startup_scan
    if task is not None and not task.done():
        # shield: a client disconnecting mid-wait must not cancel the scan itself
        await asyncio.shield(task)


async def _effective_workspace(session: AsyncSession) -> Path | None:
    """Return the effective workspace path, or None if not configured."""
    row = await session.get(AppSetting, "dbt_projects_path")
    if row is not None and row.value:
        return Path(row.value)
    if settings.dbt_projects_path is not None:
        return settings.dbt_projects_path
    return None


async def list_projects(session: AsyncSession) -> list[Project]:
    result = await session.execute(select(Project).order_by(Project.name))
    return list(result.scalars().all())


async def rescan_projects(session: AsyncSession) -> list[Project]:
    workspace = await _effective_workspace(session)
    if workspace is None:
        return await list_projects(session)
    # Walking the workspace is blocking filesystem I/O — keep it off the event loop.
    started = time.perf_counter()
    discovered: list[DiscoveredProject] = await asyncio.to_thread(discover_projects, workspace)
    log.info(
        "discovery_done",
        workspace=str(workspace),
        projects=len(discovered),
        duration_ms=round((time.perf_counter() - started) * 1000),
    )
    existing = await list_projects(session)
    by_path = {p.path: p for p in existing}

    seen_paths: set[str] = set()
    for dp in discovered:
        key = str(dp.path)
        seen_paths.add(key)
        row = by_path.get(key)
        if row is None:
            row = Project(
                name=dp.name,
                path=key,
                platform=dp.platform,
                profile=dp.profile,
            )
            session.add(row)
        else:
            row.name = dp.name
            row.platform = dp.platform
            row.profile = dp.profile

    for path, row in by_path.items():
        if path not in seen_paths:
            await session.delete(row)

    await session.commit()
    return await list_projects(session)
