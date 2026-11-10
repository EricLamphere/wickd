"""Scheduled runs (plan 27): CRUD, order, pause all, Run now and history.

Schedules run only while wickd is open; the scheduler is app/runs/scheduler.py.
Validation errors are 400 `{field, code, message}` so the editor can point at the field.
"""

from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.env import _read_profiles_yml
from app.api.scheduling import iso, schedule_error
from app.db.engine import get_session
from app.db.models import Project, RunInvocation, RunSchedule, RunScheduleEvent
from app.dbt.custom_command import CustomCommandError, ParsedCommand, parse_custom_command
from app.runs import schedule_due as sd
from app.runs import scheduler
from app.scheduling import cron
from app.scheduling.rules import MAX_INTERVAL_HOURS, MIN_INTERVAL_HOURS, next_check

router = APIRouter(prefix="/api/projects", tags=["run-schedules"])

MAX_COMMAND_LENGTH = 4096
MAX_BUSY_WAIT_MINUTES = 720
DEFAULT_BUSY_WAIT_MINUTES = 30
HISTORY_LIMIT = scheduler.MAX_EVENTS_PER_SCHEDULE


class ScheduleCreateDto(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    command: str = Field(min_length=1, max_length=MAX_COMMAND_LENGTH)
    interval_hours: int | None = Field(default=None, ge=MIN_INTERVAL_HOURS, le=MAX_INTERVAL_HOURS)
    cron: str | None = Field(default=None, max_length=200)
    target: str | None = Field(default=None, max_length=255)
    catch_up: bool = False
    busy_wait_minutes: int = Field(default=DEFAULT_BUSY_WAIT_MINUTES, ge=0, le=MAX_BUSY_WAIT_MINUTES)
    enabled: bool = True


class SchedulePatchDto(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    command: str | None = Field(default=None, min_length=1, max_length=MAX_COMMAND_LENGTH)
    interval_hours: int | None = Field(default=None, ge=MIN_INTERVAL_HOURS, le=MAX_INTERVAL_HOURS)
    cron: str | None = Field(default=None, max_length=200)
    target: str | None = Field(default=None, max_length=255)
    catch_up: bool | None = None
    busy_wait_minutes: int | None = Field(default=None, ge=0, le=MAX_BUSY_WAIT_MINUTES)
    enabled: bool | None = None


class OrderDto(BaseModel):
    ids: list[int]


class PausedDto(BaseModel):
    paused: bool


def _error(field: str, code: str, message: str) -> HTTPException:
    return HTTPException(400, {"field": field, "code": code, "message": message})


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    return project


async def _schedule(session: AsyncSession, project_id: int, schedule_id: int) -> RunSchedule:
    schedule = await session.get(RunSchedule, schedule_id)
    if schedule is None or schedule.project_id != project_id:
        raise HTTPException(404, "schedule not found")
    return schedule


def _parse_command(command: str) -> ParsedCommand:
    try:
        return parse_custom_command(command)
    except CustomCommandError as exc:
        raise _error("command", "invalid_command", str(exc)) from exc


def _normalize_cron(raw: str | None) -> str | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        return cron.normalize(text)
    except cron.CronError as exc:
        raise schedule_error(exc) from exc


def _project_targets(project: Project) -> list[str]:
    profiles = _read_profiles_yml(Path(project.path))
    name = project.profile if project.profile in profiles else (project.name if project.name in profiles else None)
    return list((profiles.get(name) or {}).get("outputs", {}).keys()) if name else []


def _check_target(project: Project, target: str | None) -> str | None:
    text = (target or "").strip() or None
    targets = _project_targets(project)
    if text is not None and targets and text not in targets:
        raise _error("target", "unknown_target", f"Target '{text}' isn't in profiles.yml ({', '.join(targets)}).")
    return text


def _check_timing(interval_hours: int | None, cron_expr: str | None) -> None:
    if interval_hours is not None and cron_expr is not None:
        raise _error("cron", "both_set", "Choose an interval or a cron schedule, not both.")


def schedule_dto(schedule: RunSchedule, *, paused: bool, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    timing = scheduler.timing_for(schedule, paused=paused, ignored=False)
    try:
        parsed = parse_custom_command(schedule.command)
        command_target, has_target = parsed.target, parsed.has_target
    except CustomCommandError:
        command_target, has_target = None, False
    return {
        "id": schedule.id,
        "name": schedule.name,
        "command": schedule.command,
        "interval_hours": schedule.interval_hours,
        "cron": schedule.cron,
        "target": schedule.target,
        "command_target": command_target,
        "has_command_target": has_target,
        "catch_up": schedule.catch_up,
        "busy_wait_minutes": schedule.busy_wait_minutes,
        "enabled": schedule.enabled,
        "position": schedule.position,
        "description": sd.describe(timing.rule),
        "next_run_at": iso(next_check(timing.rule, timing.since, now)) if timing.active else None,
        "last_fired_at": iso(schedule.last_fired_at),
        "last_status": schedule.last_status,
        "last_invocation_id": schedule.last_invocation_id,
        "last_event_id": schedule.last_event_id,
        "pending": scheduler.is_pending(schedule.id),
        "created_at": iso(schedule.created_at),
    }


async def _list(session: AsyncSession, project: Project) -> dict:
    rows = (await session.execute(
        select(RunSchedule).where(RunSchedule.project_id == project.id)
        .order_by(RunSchedule.position, RunSchedule.id)
    )).scalars().all()
    now = datetime.now(UTC)
    return {
        "paused": project.schedules_paused,
        "items": [schedule_dto(s, paused=project.schedules_paused, now=now) for s in rows],
    }


@router.get("/{project_id}/run-schedules")
async def list_schedules(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    return await _list(session, await _project(session, project_id))


@router.post("/{project_id}/run-schedules", status_code=201)
async def create_schedule(
    project_id: int, dto: ScheduleCreateDto, session: AsyncSession = Depends(get_session),
) -> dict:
    project = await _project(session, project_id)
    _parse_command(dto.command)
    expr = _normalize_cron(dto.cron)
    _check_timing(dto.interval_hours, expr)
    position = (await session.execute(
        select(func.coalesce(func.max(RunSchedule.position), -1)).where(RunSchedule.project_id == project_id)
    )).scalar_one() + 1
    schedule = RunSchedule(
        project_id=project_id, name=dto.name.strip(), command=dto.command.strip(),
        interval_hours=dto.interval_hours, cron=expr, target=_check_target(project, dto.target),
        catch_up=dto.catch_up, busy_wait_minutes=dto.busy_wait_minutes, enabled=dto.enabled,
        position=position, armed_at=datetime.now(UTC),
    )
    session.add(schedule)
    await session.commit()
    await session.refresh(schedule)
    await scheduler.publish_changed(project_id, schedule.id)
    return schedule_dto(schedule, paused=project.schedules_paused)


_TIMING_FIELDS = {"interval_hours", "cron", "enabled"}


@router.patch("/{project_id}/run-schedules/{schedule_id}")
async def update_schedule(
    project_id: int, schedule_id: int, dto: SchedulePatchDto, session: AsyncSession = Depends(get_session),
) -> dict:
    project = await _project(session, project_id)
    schedule = await _schedule(session, project_id, schedule_id)
    fields = dto.model_fields_set
    if "command" in fields and dto.command is not None:
        _parse_command(dto.command)
        schedule.command = dto.command.strip()
    if "name" in fields and dto.name is not None:
        schedule.name = dto.name.strip()
    interval = dto.interval_hours if "interval_hours" in fields else schedule.interval_hours
    expr = _normalize_cron(dto.cron) if "cron" in fields else schedule.cron
    _check_timing(interval, expr)
    retimed = (interval, expr) != (schedule.interval_hours, schedule.cron)
    reenabled = dto.enabled is True and not schedule.enabled
    schedule.interval_hours, schedule.cron = interval, expr
    if "target" in fields:
        schedule.target = _check_target(project, dto.target)
    if dto.catch_up is not None:
        schedule.catch_up = dto.catch_up
    if dto.busy_wait_minutes is not None:
        schedule.busy_wait_minutes = dto.busy_wait_minutes
    if dto.enabled is not None:
        schedule.enabled = dto.enabled
    if retimed or reenabled:  # count from now: never fire or "miss" a run straight away
        schedule.armed_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(schedule)
    await scheduler.publish_changed(project_id, schedule.id)
    return schedule_dto(schedule, paused=project.schedules_paused)


@router.delete("/{project_id}/run-schedules/{schedule_id}", status_code=204)
async def delete_schedule(project_id: int, schedule_id: int, session: AsyncSession = Depends(get_session)) -> None:
    await _project(session, project_id)
    schedule = await _schedule(session, project_id, schedule_id)
    # SQLite doesn't enforce the FK's ON DELETE here: unlink old runs (they stay in Runs) and drop the history
    await session.execute(
        update(RunInvocation).where(RunInvocation.schedule_id == schedule_id).values(schedule_id=None)
    )
    await session.execute(RunScheduleEvent.__table__.delete().where(RunScheduleEvent.schedule_id == schedule_id))
    await session.delete(schedule)
    await session.commit()
    await scheduler.publish_changed(project_id, schedule_id, deleted=True)


@router.put("/{project_id}/run-schedules/order", status_code=204)
async def reorder_schedules(project_id: int, dto: OrderDto, session: AsyncSession = Depends(get_session)) -> None:
    await _project(session, project_id)
    rows = (await session.execute(
        select(RunSchedule).where(RunSchedule.project_id == project_id)
    )).scalars().all()
    rank = {sid: i for i, sid in enumerate(dto.ids)}
    for schedule in rows:  # ids left out keep their relative order, after the listed ones
        schedule.position = rank.get(schedule.id, len(rank) + schedule.position)
    await session.commit()
    await scheduler.publish_changed(project_id)


@router.put("/{project_id}/run-schedules/paused")
async def set_paused(project_id: int, dto: PausedDto, session: AsyncSession = Depends(get_session)) -> dict:
    project = await _project(session, project_id)
    if project.schedules_paused and not dto.paused:
        # resuming counts from now, so the time spent paused isn't reported as missed runs
        await session.execute(
            update(RunSchedule).where(RunSchedule.project_id == project_id).values(armed_at=datetime.now(UTC))
        )
    project.schedules_paused = dto.paused
    await session.commit()
    await scheduler.publish_changed(project_id)
    return {"paused": dto.paused}


@router.post("/{project_id}/run-schedules/{schedule_id}/run", status_code=202)
async def run_schedule_now(project_id: int, schedule_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    await _project(session, project_id)
    schedule = await _schedule(session, project_id, schedule_id)
    _parse_command(schedule.command)
    if scheduler.is_pending(schedule_id):
        raise HTTPException(409, {"code": "pending", "message": "This schedule already has a run waiting or running."})
    event_id = await scheduler.run_now(session, schedule)
    return {"event_id": event_id}


@router.get("/{project_id}/run-schedules/{schedule_id}/history")
async def schedule_history(project_id: int, schedule_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    await _project(session, project_id)
    await _schedule(session, project_id, schedule_id)
    events = (await session.execute(
        select(RunScheduleEvent).where(RunScheduleEvent.schedule_id == schedule_id)
        .order_by(RunScheduleEvent.id.desc()).limit(HISTORY_LIMIT)
    )).scalars().all()
    return {"items": [
        {
            "id": e.id, "at": iso(e.at), "trigger": e.trigger, "outcome": e.outcome,
            "invocation_id": e.invocation_id, "message": e.message,
        }
        for e in events
    ]}
