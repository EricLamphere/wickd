"""Recurring notes and seasonal monitors (plan 33).

A `recurs: yearly` note (a holiday, Black Friday) says "this period is unusual every year".
A monitor using the seasonal algorithm treats each period inside an occurrence of a matching
recurring note as excluded: never flagged and left out of baselines, the same as a period
marked as expected. It's applied in memory at detection, never stored on the points, so
editing or deleting the note changes the next check.

Other algorithms (threshold, change, no data) are left alone: a threshold should still fire on
Black Friday.
"""

import asyncio
from datetime import date
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.logging_setup import get_logger
from app.semantic import monitor_queries as mq
from app.semantic import note_store, notes
from app.semantic.notes import NoteError, NoteMeta

log = get_logger(__name__)

SEASONAL = "seasonal"


def period_last_day(period: str, grain: str) -> str:
    """The last day (ISO) of the `grain` period starting on `period`."""
    start = mq.period_start(date.fromisoformat(period), grain)
    return date.fromordinal(mq.shift(start, grain, 1).toordinal() - 1).isoformat()


def exclude_recurring(
    series: list[dict], recurring: list[NoteMeta], *, algorithm: str, metric: str, grain: str,
    dimension: str | None, slice_: str,
) -> list[dict]:
    """`series` ([{period, value, suppressed}]) with periods a recurring note covers marked
    `suppressed`, for the seasonal algorithm; unchanged (the same list) otherwise."""
    if algorithm != SEASONAL or not recurring or not series:
        return series
    dims = {dimension: slice_} if dimension and slice_ != mq.UNSLICED else None
    out = []
    for point in series:
        period = str(point.get("period") or "")
        if not point.get("suppressed") and period and _covered(recurring, period, grain, metric, dims):
            out.append({**point, "suppressed": True})
        else:
            out.append(point)
    return out


def _covered(recurring: list[NoteMeta], period: str, grain: str, metric: str, dims: dict[str, str] | None) -> bool:
    try:
        end = period_last_day(period, grain)
    except ValueError:
        return False
    return any(notes.matches(n, start=period, end=end, metric=metric, dims=dims) for n in recurring)


async def _setting(session: AsyncSession, project_id: int, key: str) -> str | None:
    from app.db.models import ProjectEnvVar

    return (await session.execute(
        select(ProjectEnvVar.value).where(ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == key)
    )).scalar_one_or_none()


async def recurring_notes(session: AsyncSession, project_id: int, project_path: Path) -> list[NoteMeta]:
    """The project's readable `recurs: yearly` notes; [] when the notes folder can't be read."""
    try:
        folders = note_store.folders(
            project_path,
            await _setting(session, project_id, note_store.SETTING_KEY),
            await _setting(session, project_id, note_store.IMG_SETTING_KEY),
        )
        entries = await asyncio.to_thread(note_store.list_notes, folders)
    except (NoteError, OSError) as exc:
        log.warning("recurring_notes_unreadable", project_id=project_id, error=str(exc))
        return []
    return [e.note.meta for e in entries if e.note is not None and e.note.meta.recurs]


def needs_recurring(monitors: Any) -> bool:
    return any(getattr(m, "algorithm", SEASONAL) == SEASONAL for m in monitors)
