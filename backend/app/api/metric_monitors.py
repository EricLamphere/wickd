"""Metric monitors (wickd Pro): CRUD, refresh, the latest run, one monitor's series.

Every route is gated (require_pro): monitor statuses are Pro-derived results. The job
is app/semantic/monitors.py; detection is the private shim app/semantic/anomaly.py.
"""

import json
import os
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.semantic import _http_error, _project, _require_available, _semantic_http
from app.db.engine import get_session
from app.db.models import MetricMonitor, MetricMonitorRun, ProjectEnvVar
from app.licensing.gating import require_pro
from app.logging_setup import get_logger
from app.scheduling import cron
from app.semantic import anomaly, monitor_points, monitors, service
from app.semantic import monitor_queries as mq
from app.semantic import monitor_schedule as ms
from app.semantic.runtime import RuntimeUnavailable

router = APIRouter(prefix="/api/projects", tags=["metric-monitors"])
log = get_logger(__name__)

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Grain = Literal["day", "week", "month"]
Sensitivity = Literal["low", "normal", "high"]
Period = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
Schedule = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class MonitorCreateDto(BaseModel):
    metric: Name
    grain: Grain = "day"
    dimension: Name | None = None
    sensitivity: Sensitivity = "normal"
    lookback: int | None = Field(default=None, ge=1)
    target: Name | None = None  # pin a dbt target (null = the active one)


class MonitorPatchDto(BaseModel):
    sensitivity: Sensitivity | None = None
    lookback: int | None = Field(default=None, ge=1)
    enabled: bool | None = None
    target: Name | None = None  # send null explicitly to unpin
    schedule: Schedule | None = None  # "off" or cron; send null explicitly to follow the project


class RefreshDto(BaseModel):
    ids: list[int] | None = Field(default=None, max_length=mq.MAX_MONITORS)


class SuppressDto(BaseModel):
    slice: str = Field(default=mq.UNSLICED, max_length=500)
    period: Period
    suppressed: bool = True


class OrderDto(BaseModel):
    ids: list[int] = Field(max_length=mq.MAX_MONITORS)


class SettingsDto(BaseModel):
    """The project's auto-check: every `interval_hours`, a cron `schedule`, or neither (off)."""

    interval_hours: int | None = Field(default=None, ge=ms.MIN_INTERVAL_HOURS, le=ms.MAX_INTERVAL_HOURS)
    schedule: Schedule | None = None


async def _gate(session: AsyncSession) -> None:
    await require_pro(session, available=anomaly.is_available, unavailable_detail=anomaly.UNAVAILABLE)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def _json(raw: str | None, default: object) -> object:
    try:
        return json.loads(raw) if raw else default
    except ValueError:
        return default


def monitor_dto(m: MetricMonitor, project_rule: ms.Rule | None) -> dict:
    rule = ms.effective_rule(m.schedule, project_rule) if m.enabled else None
    last = monitors.last_attempt(m.id, m.last_checked_at)
    return {
        "id": m.id, "metric": m.metric, "grain": m.grain, "dimension": m.dimension, "sensitivity": m.sensitivity,
        "lookback": m.lookback, "enabled": m.enabled, "target": m.target, "slices": _json(m.slices_json, []),
        "position": m.position, "created_at": _iso(m.created_at), "last_checked_at": _iso(m.last_checked_at),
        "latest": _json(m.last_result_json, None), "schedule": m.schedule,
        "next_check_at": _iso(ms.next_check(rule, last, datetime.now(UTC))),
    }


def run_dto(run: MetricMonitorRun | None) -> dict | None:
    if run is None:
        return None
    return {
        "id": run.id, "status": run.status, "trigger": run.trigger, "target": run.target or None,
        "monitors": _json(run.monitors_json, []), "results": _json(run.results_json, []),
        "error_message": run.error_message, "started_at": _iso(run.started_at), "finished_at": _iso(run.finished_at),
    }


async def _monitor(session: AsyncSession, project_id: int, monitor_id: int) -> MetricMonitor:
    m = await session.get(MetricMonitor, monitor_id)
    if m is None or m.project_id != project_id:
        raise HTTPException(status_code=404, detail="monitor not found")
    return m


async def _settings_rows(session: AsyncSession, project_id: int) -> dict[str, ProjectEnvVar]:
    rows = (await session.execute(
        select(ProjectEnvVar).where(
            ProjectEnvVar.project_id == project_id, ProjectEnvVar.key.in_([ms.INTERVAL_KEY, ms.SCHEDULE_KEY])
        )
    )).scalars()
    return {row.key: row for row in rows}


async def _project_rule(session: AsyncSession, project_id: int) -> ms.Rule | None:
    rows = await _settings_rows(session, project_id)
    raw = {key: row.value for key, row in rows.items()}
    return ms.project_rule(raw.get(ms.INTERVAL_KEY), raw.get(ms.SCHEDULE_KEY))


def _schedule_error(exc: cron.CronError) -> HTTPException:
    return _http_error(400, "invalid_schedule", f"Invalid schedule: {exc}")


async def _latest_run(session: AsyncSession, project_id: int) -> MetricMonitorRun | None:
    return (await session.execute(
        select(MetricMonitorRun).where(MetricMonitorRun.project_id == project_id)
        .order_by(MetricMonitorRun.id.desc()).limit(1)
    )).scalar_one_or_none()


async def _active_target(session: AsyncSession, project_id: int) -> str:
    from app.api.init import project_env

    return (await project_env(session, project_id, base=os.environ)).get("DBT_TARGET") or ""


def _check_dimension(catalog: dict, metric: str, dimension: str | None) -> None:
    entry = next((m for m in catalog.get("metrics") or [] if m.get("name") == metric), None)
    if entry is None:
        raise _http_error(400, "invalid_query", f"there's no metric named `{metric}`")
    if dimension is None:
        return
    dims = {d.get("name"): d for d in entry.get("dimensions") or []}
    found = dims.get(dimension)
    if found is None:
        raise _http_error(400, "invalid_query", f"`{metric}` can't be sliced by `{dimension}`")
    if found.get("type") == "time" or found.get("time_granularity"):
        raise _http_error(400, "invalid_query", "slice by a categorical dimension, not a time one")


# ── routes ───────────────────────────────────────────────────────────────────


@router.get("/{project_id}/metric-monitors")
async def list_monitors(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    await _project(session, project_id)
    await _gate(session)
    rows = (await session.execute(
        select(MetricMonitor).where(MetricMonitor.project_id == project_id)
        .order_by(MetricMonitor.position, MetricMonitor.id)
    )).scalars()
    rule = await _project_rule(session, project_id)
    return {
        "monitors": [monitor_dto(m, rule) for m in rows],
        "running": project_id in monitors.running,
        "interval_hours": rule.hours if rule else None,
        "schedule": rule.expr if rule else None,
        "max_monitors": mq.MAX_MONITORS,
        "active_target": await _active_target(session, project_id) or None,
        "last_run": run_dto(await _latest_run(session, project_id)),
    }


@router.post("/{project_id}/metric-monitors", status_code=201)
async def create_monitor(project_id: int, dto: MonitorCreateDto, session: AsyncSession = Depends(get_session)) -> dict:
    project = await _project(session, project_id)
    await _gate(session)
    await _require_available(session, project, query=True)
    count = (await session.execute(
        select(func.count()).select_from(MetricMonitor).where(MetricMonitor.project_id == project_id)
    )).scalar_one()
    if count >= mq.MAX_MONITORS:
        raise _http_error(409, "too_many_monitors", f"A project can have at most {mq.MAX_MONITORS} monitors.")
    try:
        catalog = await service.catalog(Path(project.path))
    except (service.SemanticError, RuntimeUnavailable) as exc:
        raise _semantic_http(exc) from exc
    _check_dimension(catalog, dto.metric, dto.dimension)
    duplicate = (await session.execute(
        select(MetricMonitor.id).where(
            MetricMonitor.project_id == project_id, MetricMonitor.metric == dto.metric,
            MetricMonitor.grain == dto.grain, MetricMonitor.dimension.is_(None) if dto.dimension is None
            else MetricMonitor.dimension == dto.dimension,
            MetricMonitor.target.is_(None) if dto.target is None else MetricMonitor.target == dto.target,
        )
    )).first()
    if duplicate is not None:
        raise _http_error(409, "duplicate_monitor", "This metric is already monitored at that grain.")
    lookback = min(dto.lookback or mq.DEFAULT_LOOKBACK[dto.grain], mq.MAX_LOOKBACK[dto.grain])
    last = (await session.execute(
        select(func.max(MetricMonitor.position)).where(MetricMonitor.project_id == project_id)
    )).scalar_one_or_none()
    m = MetricMonitor(
        project_id=project_id, metric=dto.metric, grain=dto.grain, dimension=dto.dimension,
        sensitivity=dto.sensitivity, lookback=lookback, enabled=True, target=dto.target,
        position=(last if last is not None else -1) + 1,
    )
    session.add(m)
    await session.commit()
    await session.refresh(m)
    await monitors.request_refresh(project_id, [m.id], "manual")
    log.info("metric_monitor_created", project_id=project_id, monitor_id=m.id, metric=dto.metric, grain=dto.grain)
    return monitor_dto(m, await _project_rule(session, project_id))


@router.patch("/{project_id}/metric-monitors/{monitor_id}")
async def patch_monitor(
    project_id: int, monitor_id: int, dto: MonitorPatchDto, session: AsyncSession = Depends(get_session)
) -> dict:
    await _project(session, project_id)
    await _gate(session)
    m = await _monitor(session, project_id, monitor_id)
    if dto.sensitivity is not None:
        m.sensitivity = dto.sensitivity
    if dto.lookback is not None:
        m.lookback = min(dto.lookback, mq.MAX_LOOKBACK[m.grain])
    if dto.enabled is not None:
        m.enabled = dto.enabled
    if "target" in dto.model_fields_set:
        m.target = dto.target
    if "schedule" in dto.model_fields_set:
        try:
            m.schedule = ms.check_override(dto.schedule)
        except cron.CronError as exc:
            raise _schedule_error(exc) from exc
    await session.commit()
    await session.refresh(m)
    return monitor_dto(m, await _project_rule(session, project_id))


@router.delete("/{project_id}/metric-monitors/{monitor_id}", status_code=204)
async def delete_monitor(project_id: int, monitor_id: int, session: AsyncSession = Depends(get_session)) -> Response:
    await _project(session, project_id)
    await _gate(session)
    m = await _monitor(session, project_id, monitor_id)
    await monitor_points.delete_all(session, m.id)
    await session.delete(m)
    await session.commit()
    return Response(status_code=204)


@router.post("/{project_id}/metric-monitors/refresh")
async def refresh(project_id: int, dto: RefreshDto, session: AsyncSession = Depends(get_session)) -> dict:
    """Check now: {run_id} of the started refresh, or {queued: true} behind the running one."""
    project = await _project(session, project_id)
    await _gate(session)
    await _require_available(session, project, query=True)
    run_id = await monitors.request_refresh(project_id, dto.ids, "manual")
    return {"run_id": run_id, "queued": run_id is None}


@router.get("/{project_id}/metric-monitors/latest")
async def latest(project_id: int, session: AsyncSession = Depends(get_session)) -> dict | None:
    await _project(session, project_id)
    await _gate(session)
    return run_dto(await _latest_run(session, project_id))


@router.put("/{project_id}/metric-monitors/order", status_code=204)
async def put_order(project_id: int, dto: OrderDto, session: AsyncSession = Depends(get_session)) -> Response:
    """Drag-to-reorder on the Monitors tab: `ids` in their new order. Monitors not listed
    (e.g. one created meanwhile) keep their relative order after the listed ones."""
    await _project(session, project_id)
    await _gate(session)
    rows = (await session.execute(
        select(MetricMonitor).where(MetricMonitor.project_id == project_id)
        .order_by(MetricMonitor.position, MetricMonitor.id)
    )).scalars().all()
    by_id = {m.id: m for m in rows}
    unknown = [i for i in dto.ids if i not in by_id]
    if unknown or len(set(dto.ids)) != len(dto.ids):
        raise _http_error(400, "bad_order", "ids must be distinct monitors of this project")
    listed = set(dto.ids)
    ordered = [by_id[i] for i in dto.ids] + [m for m in rows if m.id not in listed]
    for position, m in enumerate(ordered):
        m.position = position
    await session.commit()
    return Response(status_code=204)


@router.put("/{project_id}/metric-monitors/settings")
async def put_settings(project_id: int, dto: SettingsDto, session: AsyncSession = Depends(get_session)) -> dict:
    """The automatic check while wickd is open: an interval, a cron schedule, or off (both
    null). Stored as the MONITOR_INTERVAL_HOURS / MONITOR_SCHEDULE project env vars; setting
    one clears the other. Monitors with their own schedule keep it."""
    await _project(session, project_id)
    await _gate(session)
    if dto.interval_hours is not None and dto.schedule is not None:
        raise _http_error(400, "invalid_schedule", "Choose an interval or a schedule, not both.")
    try:
        schedule = cron.normalize(dto.schedule) if dto.schedule is not None else None
    except cron.CronError as exc:
        raise _schedule_error(exc) from exc
    wanted = {
        ms.INTERVAL_KEY: str(dto.interval_hours) if dto.interval_hours is not None else None,
        ms.SCHEDULE_KEY: schedule,
    }
    rows = await _settings_rows(session, project_id)
    for key, value in wanted.items():
        row = rows.get(key)
        if value is None:
            if row is not None:
                await session.delete(row)
        elif row is None:
            session.add(ProjectEnvVar(project_id=project_id, key=key, value=value))
        else:
            row.value = value
    await session.commit()
    return {"interval_hours": dto.interval_hours, "schedule": schedule}


@router.get("/{project_id}/metric-monitors/schedule-preview")
async def schedule_preview(project_id: int, expr: str, session: AsyncSession = Depends(get_session)) -> dict:
    """A cron expression checked as you type: {expr (as stored), next: [the next 3 times]}."""
    await _project(session, project_id)
    await _gate(session)
    try:
        normalized = cron.normalize(expr[:200])
    except cron.CronError as exc:
        raise _schedule_error(exc) from exc
    return {"expr": normalized, "next": [_iso(t) for t in ms.upcoming(normalized, datetime.now(UTC))]}


@router.get("/{project_id}/metric-monitors/{monitor_id}/series")
async def series(
    project_id: int, monitor_id: int, slice: str = mq.UNSLICED, target: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """The stored history of one slice, scored again: {monitor, slice, target, points, summary, restatements}."""
    await _project(session, project_id)
    await _gate(session)
    m = await _monitor(session, project_id, monitor_id)
    spec = monitors.spec_of(m)
    target_name = target if target is not None else (m.target or await _active_target(session, project_id))
    since = mq.window_start(date.today(), m.grain, m.lookback, has_history=False).isoformat()
    stored = await monitor_points.series(session, m.id, target_name, slice, since)
    detected = anomaly.detect(stored, grain=m.grain, sensitivity=m.sensitivity, previous=None, now=date.today())
    return {
        "monitor": monitor_dto(m, await _project_rule(session, project_id)),
        "slice": slice,
        "slices": [mq.slice_key(s) for s in spec.slices] if spec.dimension else [],
        "target": target_name or None,
        "points": detected["points"],
        "summary": detected["summary"],
        "restatements": await monitor_points.restatements(session, m.id, target_name, slice),
    }


@router.post("/{project_id}/metric-monitors/{monitor_id}/points/suppress")
async def suppress(
    project_id: int, monitor_id: int, dto: SuppressDto, target: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Mark a period as expected (or not): it's no longer flagged nor used in baselines."""
    await _project(session, project_id)
    await _gate(session)
    m = await _monitor(session, project_id, monitor_id)
    target_name = target if target is not None else (m.target or await _active_target(session, project_id))
    if not await monitor_points.set_suppressed(session, m.id, target_name, dto.slice, dto.period, dto.suppressed):
        raise HTTPException(status_code=404, detail="no stored value for that period")
    await session.commit()
    return {"ok": True}
