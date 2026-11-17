"""The Marked as expected log (plan 30; Pro, with monitors).

GET   /api/projects/{id}/metric-monitors/expectations?monitor_id=  → {expectations}, newest first
PATCH /api/projects/{id}/metric-monitors/expectations/{eid}        → link a note ({note_slug}, null unlinks)

Rows are written and removed by POST …/metric-monitors/{mid}/points/suppress (api/metric_monitors.py).
Registered before the monitors router so `expectations` is never read as a monitor id.
"""

import asyncio
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.semantic import _project
from app.db.engine import get_session
from app.db.models import Project, ProjectEnvVar
from app.events.bus import Event, bus
from app.licensing.gating import require_pro
from app.semantic import anomaly, note_store
from app.semantic import monitor_expectations as log_store
from app.semantic.notes import SLUG_PATTERN, NoteError

router = APIRouter(prefix="/api/projects", tags=["metric-monitors"])
EVENT = "metric_monitor_expectations_changed"


class LinkDto(BaseModel):
    note_slug: Annotated[str, StringConstraints(pattern=SLUG_PATTERN)] | None = None


async def publish_changed(project_id: int, expectation_id: int | None) -> None:
    await bus.publish(Event(topic=f"project:{project_id}", type=EVENT, data={"expectation_id": expectation_id}))


async def note_slugs(session: AsyncSession, project: Project) -> set[str] | None:
    """Slugs of the project's note files (None when the notes folder setting is invalid)."""
    async def setting(key: str) -> str | None:
        return (await session.execute(
            select(ProjectEnvVar.value).where(ProjectEnvVar.project_id == project.id, ProjectEnvVar.key == key)
        )).scalar_one_or_none()
    try:
        f = note_store.folders(Path(project.path), await setting(note_store.SETTING_KEY),
                               await setting(note_store.IMG_SETTING_KEY))
    except NoteError:
        return None
    if not f.notes.is_dir():
        return set()
    return await asyncio.to_thread(lambda: {p.stem for p in f.notes.glob(f"*{note_store.SUFFIX}")})


@router.get("/{project_id}/metric-monitors/expectations")
async def list_expectations(
    project_id: int, monitor_id: int | None = None, session: AsyncSession = Depends(get_session)
) -> dict:
    project = await _project(session, project_id)
    await require_pro(session, available=anomaly.is_available, unavailable_detail=anomaly.UNAVAILABLE)
    rows = await log_store.list_for_project(session, project_id, monitor_id)
    slugs = await note_slugs(session, project) if any(r.note_slug for r in rows) else None
    return {"expectations": [log_store.to_dto(r, slugs) for r in rows]}


@router.patch("/{project_id}/metric-monitors/expectations/{expectation_id}")
async def link_note(
    project_id: int, expectation_id: int, dto: LinkDto, session: AsyncSession = Depends(get_session)
) -> dict:
    project = await _project(session, project_id)
    await require_pro(session, available=anomaly.is_available, unavailable_detail=anomaly.UNAVAILABLE)
    row = await log_store.get_for_project(session, project_id, expectation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no such marked period")
    row.note_slug = dto.note_slug
    await session.commit()
    await publish_changed(project_id, row.id)
    return log_store.to_dto(row, await note_slugs(session, project) if row.note_slug else None)
