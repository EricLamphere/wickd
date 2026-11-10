"""When something scheduled is due (pure, unit-tested).

A schedule is every N hours or a cron expression (cron.py), decided against the last
time it ran (or was attempted, so a failure isn't retried every tick): an interval is
due once N hours have passed; a cron schedule is due when it fired since then. Cron
times are the machine's local time.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.scheduling import cron

MIN_INTERVAL_HOURS = 1
MAX_INTERVAL_HOURS = 24 * 7


@dataclass(frozen=True)
class Rule:
    """A schedule: `hours` for an interval, else `expr` (cron). `source` says where the
    rule came from for callers that layer schedules (metric monitors: project | monitor)."""

    source: str = ""
    hours: int | None = None
    expr: str | None = None


def parse_interval(raw: str | None) -> int | None:
    """Hours between runs, None when off (empty, invalid or under the minimum)."""
    text = (raw or "").strip()
    if not text.isdigit():
        return None
    hours = int(text)
    return hours if hours >= MIN_INTERVAL_HOURS else None


def parse_schedule(raw: str | None) -> str | None:
    """A stored cron expression, None when unset or no longer valid."""
    text = (raw or "").strip()
    if not text:
        return None
    try:
        return cron.normalize(text)
    except cron.CronError:
        return None


def _local(value: datetime) -> datetime:
    """Aware → naive local wall-clock time (DST-correct for that instant)."""
    return value.astimezone().replace(tzinfo=None)


def _aware(local: datetime) -> datetime:
    return local.astimezone().astimezone(UTC)


def last_fire(rule: Rule, now: datetime) -> datetime | None:
    """A cron rule's most recent fire time at or before `now` (aware UTC); None for an interval."""
    if rule.expr is None:
        return None
    fired = cron.previous_fire(cron.parse(rule.expr), _local(now))
    return _aware(fired) if fired is not None else None


def is_due(rule: Rule, last: datetime | None, now: datetime) -> bool:
    if last is None:
        return True
    if rule.hours is not None:
        return now - last >= timedelta(hours=rule.hours)
    fired = cron.previous_fire(cron.parse(rule.expr or ""), _local(now))
    return fired is not None and fired > _local(last)


def next_check(rule: Rule | None, last: datetime | None, now: datetime) -> datetime | None:
    """When the scheduler will next fire (aware UTC), None without a schedule.
    The scheduler ticks every minute, so the actual fire can be up to a minute later."""
    if rule is None:
        return None
    if rule.hours is not None:
        return now if last is None else max(now, last + timedelta(hours=rule.hours))
    if is_due(rule, last, now):
        return now
    fire = cron.next_fire(cron.parse(rule.expr or ""), _local(now))
    return _aware(fire) if fire is not None else None


def upcoming(expr: str, now: datetime, count: int = 3) -> list[datetime]:
    """The next `count` fire times of a cron expression (aware UTC); CronError if invalid."""
    return [_aware(t) for t in cron.upcoming(cron.parse(expr), _local(now), count)]
