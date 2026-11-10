"""Scheduled runs while wickd is open (plan 27).

`tick(now)` is registered on the shared scheduler loop (app/scheduling/loop.py). Each
tick loads the enabled schedules, asks schedule_due.due() which to act on, and either
records a `missed` run or starts `_fire()` in the background.

A fire is an ordinary custom-command run (api/runs.py `_run_custom_and_persist`), with
`trigger="schedule"` and the schedule's id on the invocation, so it goes through the
runner lock, shows in the Execution DAG and Runs list, persists statuses and refreshes
monitors exactly like a run you started. If the project's runner is busy, the fire
waits up to the schedule's `busy_wait_minutes` and then records `skipped_busy`. A
schedule has at most one fire in flight (`_pending`), so runs never pile up.

Every fire is a `run_schedule_events` row that moves pending → running → the run's
status (or missed / skipped_busy / invalid); `run_schedules_changed` is published on
each change.
"""

import asyncio
import time
from collections.abc import Coroutine
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import engine as db_engine
from app.db.models import Project, RunSchedule, RunScheduleEvent
from app.dbt.custom_command import CustomCommandError, parse_custom_command
from app.dbt.runner import runner
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.runs import schedule_due as sd
from app.scheduling import loop as scheduler_loop

log = get_logger(__name__)

BUSY_POLL_S = 15.0
MAX_EVENTS_PER_SCHEDULE = 50
FAILED_OUTCOMES = frozenset({"error", "invalid", "skipped_busy"})

_pending: set[int] = set()  # schedule ids with a fire in flight
_tasks: set[asyncio.Task] = set()


def is_pending(schedule_id: int) -> bool:
    return schedule_id in _pending


def _spawn(coro: Coroutine[Any, Any, None]) -> None:
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def publish_changed(project_id: int, schedule_id: int | None = None, **data: Any) -> None:
    await bus.publish(Event(
        topic=f"project:{project_id}",
        type="run_schedules_changed",
        data={"schedule_id": schedule_id, **data},
    ))


def timing_for(schedule: RunSchedule, *, paused: bool, ignored: bool) -> sd.ScheduleTiming:
    return sd.ScheduleTiming(
        id=schedule.id,
        rule=sd.rule_for(schedule.interval_hours, schedule.cron),
        since=sd.since_for(schedule.last_fired_at, schedule.armed_at, schedule.created_at),
        catch_up=schedule.catch_up,
        active=schedule.enabled and not paused and not ignored,
    )


# ── tick ─────────────────────────────────────────────────────────────────────


async def tick(now: datetime) -> list[int]:
    """Act on the due schedules; the ids of schedules whose run was started."""
    started: list[tuple[int, int, int]] = []  # (project_id, schedule_id, event_id)
    changed: list[tuple[int, int, str]] = []
    async with db_engine.SessionLocal() as session:
        rows = (await session.execute(
            select(RunSchedule, Project.schedules_paused, Project.ignored)
            .join(Project, Project.id == RunSchedule.project_id)
            .where(RunSchedule.enabled.is_(True))
        )).all()
        by_id = {schedule.id: schedule for schedule, _, _ in rows}
        timings = [timing_for(schedule, paused=paused, ignored=ignored) for schedule, paused, ignored in rows]
        for d in sd.due(timings, now):
            if d.id in _pending:
                continue
            schedule = by_id[d.id]
            event = await _record_fire(session, schedule, now, d)
            changed.append((schedule.project_id, schedule.id, d.outcome))
            if d.outcome == "run":
                _pending.add(schedule.id)
                started.append((schedule.project_id, schedule.id, event.id))
        await session.commit()
    for project_id, schedule_id, outcome in changed:
        await publish_changed(project_id, schedule_id, outcome="missed" if outcome == "missed" else "pending")
    for _, schedule_id, event_id in started:
        _spawn(_fire(schedule_id, event_id, "schedule"))
    return [schedule_id for _, schedule_id, _ in started]


async def _record_fire(session: AsyncSession, schedule: RunSchedule, now: datetime, d: sd.Due) -> RunScheduleEvent:
    missed = d.outcome == "missed"
    event = RunScheduleEvent(
        schedule_id=schedule.id, at=d.scheduled_for if missed else now, trigger="schedule",
        outcome="missed" if missed else "pending",
        message="wickd wasn't open at the scheduled time" if missed else "",
    )
    session.add(event)
    await session.flush()
    schedule.last_fired_at = now
    schedule.last_status = event.outcome
    schedule.last_event_id = event.id
    await _trim_events(session, schedule.id)
    return event


async def _trim_events(session: AsyncSession, schedule_id: int) -> None:
    keep = select(RunScheduleEvent.id).where(RunScheduleEvent.schedule_id == schedule_id) \
        .order_by(RunScheduleEvent.id.desc()).limit(MAX_EVENTS_PER_SCHEDULE)
    await session.execute(
        delete(RunScheduleEvent).where(
            RunScheduleEvent.schedule_id == schedule_id, RunScheduleEvent.id.not_in(keep.scalar_subquery()),
        )
    )


# ── Run now ──────────────────────────────────────────────────────────────────


async def run_now(session: AsyncSession, schedule: RunSchedule) -> int:
    """Start a schedule's command right away (trigger `manual`, linked to the schedule).
    Doesn't move the schedule's timing. The caller checks `is_pending` first."""
    event = RunScheduleEvent(schedule_id=schedule.id, at=datetime.now(UTC), trigger="manual", outcome="pending")
    session.add(event)
    await session.flush()
    schedule.last_status = "pending"
    schedule.last_event_id = event.id
    await _trim_events(session, schedule.id)
    await session.commit()
    _pending.add(schedule.id)
    await publish_changed(schedule.project_id, schedule.id, outcome="pending")
    _spawn(_fire(schedule.id, event.id, "manual"))
    return event.id


# ── one fire ─────────────────────────────────────────────────────────────────


async def wait_for_runner(project_id: int, timeout_s: float) -> bool:
    """True once the project's runner is free, False if it stays busy past `timeout_s`."""
    deadline = time.monotonic() + timeout_s
    while runner.is_project_busy(project_id):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        await asyncio.sleep(min(BUSY_POLL_S, remaining))
    return True


async def _load(schedule_id: int) -> tuple[RunSchedule, Project] | None:
    async with db_engine.SessionLocal() as session:
        schedule = await session.get(RunSchedule, schedule_id)
        project = await session.get(Project, schedule.project_id) if schedule is not None else None
        if schedule is None or project is None:
            return None
        session.expunge_all()
        return schedule, project


async def _fire(schedule_id: int, event_id: int, trigger: str) -> None:
    try:
        loaded = await _load(schedule_id)
        if loaded is None:
            return
        schedule, _ = loaded
        if not await wait_for_runner(schedule.project_id, schedule.busy_wait_minutes * 60):
            wait = schedule.busy_wait_minutes
            message = (f"Another dbt command was still running after {wait} min" if wait
                       else "Another dbt command was running")
            await _update(schedule_id, event_id, "skipped_busy", message=message)
            return
        loaded = await _load(schedule_id)  # it may have been edited or deleted while waiting
        if loaded is None:
            return
        await _start_run(*loaded, event_id=event_id, trigger=trigger)
    except Exception as exc:
        log.exception("scheduled_run_failed", schedule_id=schedule_id)
        await _update(schedule_id, event_id, "error", message=f"Couldn't start the run: {exc}"[:500])
    finally:
        _pending.discard(schedule_id)


async def _start_run(schedule: RunSchedule, project: Project, *, event_id: int, trigger: str) -> None:
    from app.api.runs import _run_custom_and_persist  # runs imports a lot; keep it lazy

    try:
        parsed = parse_custom_command(schedule.command)
    except CustomCommandError as exc:
        await _update(schedule.id, event_id, "invalid", message=str(exc))
        return

    async def on_start(invocation_id: int) -> None:
        await _update(schedule.id, event_id, "running", invocation_id)

    invocation_id, status = await _run_custom_and_persist(
        project, parsed, target=schedule.target, trigger=trigger, schedule_id=schedule.id, on_start=on_start,
    )
    await _update(schedule.id, event_id, status, invocation_id)


async def _update(
    schedule_id: int, event_id: int, outcome: str, invocation_id: int | None = None, message: str = "",
) -> None:
    """Move a fire's event (and the schedule's last outcome, if it's still the latest) along."""
    async with db_engine.SessionLocal() as session:
        event = await session.get(RunScheduleEvent, event_id)
        schedule = await session.get(RunSchedule, schedule_id)
        if event is None or schedule is None:
            return
        event.outcome = outcome
        if invocation_id is not None:
            event.invocation_id = invocation_id
        if message:
            event.message = message
        if schedule.last_event_id == event_id:
            schedule.last_status = outcome
            if invocation_id is not None:
                schedule.last_invocation_id = invocation_id
        project_id, name = schedule.project_id, schedule.name
        await session.commit()
    await publish_changed(
        project_id, schedule_id, outcome=outcome, name=name, invocation_id=invocation_id, event_id=event_id,
    )


scheduler_loop.register("run_schedules", tick)
