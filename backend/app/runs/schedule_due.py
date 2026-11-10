"""Which scheduled runs are due on a tick (pure, unit-tested in test_schedule_due.py).

A schedule counts from `since` = max(last fire attempt, armed_at, created_at), so a new,
re-enabled or re-timed schedule never fires (or misses) straight away. An interval is
due N hours after `since`; a cron schedule is due when it fired after `since`.

A due time more than GRACE in the past means wickd was closed (or asleep) when it
passed. Without `catch_up` that run is reported `missed` rather than started: a
`dbt build` at launch is expensive and surprising. With `catch_up` it runs once.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.scheduling.rules import Rule, last_fire, parse_interval, parse_schedule

GRACE = timedelta(minutes=5)


@dataclass(frozen=True)
class ScheduleTiming:
    id: int
    rule: Rule | None
    since: datetime | None  # aware
    catch_up: bool = False
    active: bool = True  # enabled, project not paused or ignored


@dataclass(frozen=True)
class Due:
    id: int
    outcome: str  # run | missed
    scheduled_for: datetime  # aware: the fire time that came due


def rule_for(interval_hours: int | None, cron_expr: str | None) -> Rule | None:
    """A stored schedule's rule; cron wins if both are somehow set, invalid values are off."""
    expr = parse_schedule(cron_expr)
    if expr is not None:
        return Rule(expr=expr)
    hours = parse_interval(str(interval_hours) if interval_hours is not None else None)
    return Rule(hours=hours) if hours is not None else None


def _aware(value: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; they were stored as UTC."""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def since_for(*times: datetime | None) -> datetime | None:
    """The latest of the given times (aware), None if all are None."""
    present = [t for t in (_aware(v) for v in times) if t is not None]
    return max(present) if present else None


def scheduled_time(rule: Rule, since: datetime, now: datetime) -> datetime | None:
    """The fire time that is due now, None when nothing came due since `since`."""
    if rule.hours is not None:
        due_at = since + timedelta(hours=rule.hours)
        return due_at if now >= due_at else None
    fired = last_fire(rule, now)
    return fired if fired is not None and fired > since else None


def due(schedules: list[ScheduleTiming], now: datetime) -> list[Due]:
    """The schedules to act on now: run them, or record a missed run."""
    result: list[Due] = []
    for s in schedules:
        if not s.active or s.rule is None or s.since is None:
            continue
        at = scheduled_time(s.rule, s.since, now)
        if at is None:
            continue
        missed = not s.catch_up and now - at > GRACE
        result.append(Due(id=s.id, outcome="missed" if missed else "run", scheduled_for=at))
    return result


def describe(rule: Rule | None) -> str:
    """A short label for the API; the UI renders presets more nicely."""
    if rule is None:
        return "off"
    if rule.hours is not None:
        return "every hour" if rule.hours == 1 else f"every {rule.hours} h"
    return f"cron {rule.expr}"
