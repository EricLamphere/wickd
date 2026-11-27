"""Draft with Wicky (Pro; plan 33): a metric note about a monitor's flagged period.

POST /api/projects/{id}/metric-notes/draft  {monitor_id, period, slice, target?} → {title, body}

The facts are the period as detection scores it now (value, expected, normal range, kind), the
stored series around it, notes near it, and the metric's definition from the semantic manifest.
wickd_pro writes the prompt and validates the answer; nothing is saved: the New note dialog
opens with the draft for the user to edit and save.
"""

import asyncio
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import pro
from app.ai.client import LlmError, stream_chat
from app.ai.config import load_ai_config
from app.ai.gating import require_ai
from app.ai.provider import resolve_provider
from app.ai.runtime import RuntimeUnavailable, llama_server
from app.db.engine import get_session
from app.db.models import MetricMonitor, Project
from app.logging_setup import get_logger
from app.semantic import anomaly, monitor_points, monitors, note_store, notes, service
from app.semantic import monitor_queries as mq
from app.semantic.notes import NoteError

router = APIRouter(prefix="/api/projects", tags=["metric-notes"])
log = get_logger(__name__)

NEARBY_DAYS = 45


class DraftDto(BaseModel):
    monitor_id: int
    period: Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
    slice: Annotated[str, StringConstraints(max_length=500)] = ""
    target: str | None = None


async def _monitor(session: AsyncSession, project_id: int, monitor_id: int) -> MetricMonitor:
    m = await session.get(MetricMonitor, monitor_id)
    if m is None or m.project_id != project_id:
        raise HTTPException(status_code=404, detail="monitor not found")
    return m


def _metric_entry(project_path: Path, metric: str) -> dict | None:
    try:
        data = json.loads((service.target_dir(project_path) / "semantic_manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for m in data.get("metrics") or []:
        if isinstance(m, dict) and m.get("name") == metric:
            return {"description": m.get("description") or "", "type": m.get("type") or "", "label": m.get("label")}
    return None


def _prompt_note(e: note_store.NoteEntry) -> dict:
    meta = e.note.meta
    return {
        "slug": e.slug, "title": meta.title, "start": meta.start, "end": meta.end, "metrics": list(meta.metrics),
        "dimension": meta.dimension, "value": meta.value, "tags": list(meta.tags), "type": meta.type or "note", "status": meta.status,
        "resolved": meta.resolved, "recurs": meta.recurs, "body": e.note.body,
    }


async def _entries(session: AsyncSession, project_id: int) -> list[note_store.NoteEntry]:
    from app.api.metric_notes import _context  # notes folders from the project's settings

    _, folders = await _context(session, project_id)
    try:
        return await asyncio.to_thread(note_store.list_notes, folders)
    except (NoteError, OSError):
        return []


async def notes_for_ai(session: AsyncSession, project_id: int) -> list[dict]:
    """Every readable note as a prompt dict, for Ask (wickd_pro cuts them to its budget);
    [] when the installed wickd_pro doesn't take notes or the folder can't be read."""
    if not pro.supports_notes():
        return []
    try:
        entries = await _entries(session, project_id)
    except HTTPException:
        return []
    return [_prompt_note(e) for e in entries if e.note is not None]


def nearby_notes(entries: list[note_store.NoteEntry], metric: str, period: str) -> list[dict]:
    """Notes about `metric` (or every metric) within NEARBY_DAYS of `period`, as prompt dicts."""
    day = date.fromisoformat(period)
    lo, hi = (day - timedelta(days=NEARBY_DAYS)).isoformat(), (day + timedelta(days=NEARBY_DAYS)).isoformat()
    out = []
    for e in entries:
        if e.note is not None and notes.matches(e.note.meta, start=lo, end=hi, metric=metric):
            out.append(_prompt_note(e))
    return out


async def _complete(session: AsyncSession, prompt: dict) -> str:
    config = await load_ai_config(session)
    provider = await resolve_provider(config)
    parts: list[str] = []
    async for delta in stream_chat(provider, prompt["messages"], max_tokens=prompt.get("max_tokens"), schema=prompt.get("schema")):
        parts.append(delta)
        llama_server.touch()
    return "".join(parts)


@router.post("/{project_id}/metric-notes/draft")
async def draft_metric_note(project_id: int, dto: DraftDto, session: AsyncSession = Depends(get_session)) -> dict:
    await require_ai(session)
    if not pro.supports_notes():
        raise HTTPException(status_code=503, detail="This wickd Pro build can't draft notes; update it.")
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    m = await _monitor(session, project_id, dto.monitor_id)
    from app.api.metric_monitors import _active_target  # the monitors API's own resolution

    target = dto.target if dto.target is not None else (m.target or await _active_target(session, project_id))
    since = mq.window_start(date.today(), m.grain, m.lookback, has_history=False).isoformat()
    stored = await monitor_points.series(session, m.id, target, dto.slice, since)
    try:
        detected = monitors.detect_for(monitors.spec_of(m), stored, previous=None, today=date.today())
    except (anomaly.AnomalyUnavailable, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    point = next((p for p in detected["points"] if str(p.get("period")) == dto.period), None)
    if point is None:
        raise HTTPException(status_code=404, detail="no stored value for that period")

    entries = await _entries(session, project_id)
    metric = await asyncio.to_thread(_metric_entry, Path(project.path), m.metric)
    flag = {
        "metric": m.metric, "label": (metric or {}).get("label"), "grain": m.grain, "period": dto.period,
        "kind": point.get("kind"), "value": point.get("value"), "expected": point.get("expected"),
        "low": point.get("low"), "high": point.get("high"), "dimension": m.dimension, "slice": dto.slice or None,
    }
    series = [{"period": str(p.get("period")), "value": p.get("value"), "expected": p.get("expected")} for p in detected["points"]]
    prompt = pro.draft_note_messages(flag, series, nearby_notes(entries, m.metric, dto.period), metric)
    try:
        raw = await _complete(session, prompt)
        draft = pro.parse_note_draft(raw)
    except (RuntimeUnavailable, LlmError) as exc:
        log.warning("note_draft_failed", project_id=project_id, error=str(exc))
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"Wicky's draft couldn't be used: {exc}") from exc
    log.info("note_drafted", project_id=project_id, monitor_id=m.id, period=dto.period)
    return draft
