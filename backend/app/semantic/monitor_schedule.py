"""When metric monitors check themselves while wickd is open (pure, unit-tested).

A project has at most one automatic schedule: every N hours (`MONITOR_INTERVAL_HOURS`)
or a cron expression (`MONITOR_SCHEDULE`, see cron.py). A monitor can override it with
its own cron expression or `off` (`metric_monitors.schedule`; NULL follows the project).

Due is decided per monitor from its last check (or last scheduled attempt, so a failing
refresh isn't retried every tick): an interval is due once N hours have passed; a cron
schedule is due when it fired since then. A cron time missed while wickd was closed is
therefore checked once when it next opens. Cron times are the machine's local time.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.semantic import cron

INTERVAL_KEY = "MONITOR_INTERVAL_HOURS"
SCHEDULE_KEY = "MONITOR_SCHEDULE"
MIN_INTERVAL_HOURS = 1
MAX_INTERVAL_HOURS = 24 * 7
OFF = "off"


@dataclass(frozen=True)
class Rule:
    """A monitor's effective schedule: `hours` for an interval, else `expr` (cron)."""

    source: str  # project | monitor
    hours: int | None = None
    expr: str | None = None


@dataclass(frozen=True)
class MonitorTiming:
    id: int
    schedule: str | None  # the monitor's override: None (project), "off" or cron
    last: datetime | None  # aware: last check or scheduled attempt, whichever is later


def parse_interval(raw: str | None) -> int | None:
    """Hours between automatic refreshes, None when off (empty, invalid or under the minimum)."""
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


def project_rule(interval_raw: str | None, schedule_raw: str | None) -> Rule | None:
    """The project's schedule; a cron expression wins if both rows somehow exist."""
    expr = parse_schedule(schedule_raw)
    if expr is not None:
        return Rule(source="project", expr=expr)
    hours = parse_interval(interval_raw)
    return Rule(source="project", hours=hours) if hours is not None else None


def check_override(raw: str | None) -> str | None:
    """A monitor override as stored (None, "off" or a normalised cron); CronError if invalid."""
    text = (raw or "").strip()
    if not text:
        return None
    if text.lower() == OFF:
        return OFF
    return cron.normalize(text)


def effective_rule(override: str | None, project: Rule | None) -> Rule | None:
    if override is None:
        return project
    if override == OFF:
        return None
    try:
        cron.parse(override)
    except cron.CronError:
        return None
    return Rule(source="monitor", expr=override)


def _local(value: datetime) -> datetime:
    """Aware → naive local wall-clock time (DST-correct for that instant)."""
    return value.astimezone().replace(tzinfo=None)


def _aware(local: datetime) -> datetime:
    return local.astimezone().astimezone(UTC)


def is_due(rule: Rule, last: datetime | None, now: datetime) -> bool:
    if last is None:
        return True
    if rule.hours is not None:
        return now - last >= timedelta(hours=rule.hours)
    fired = cron.previous_fire(cron.parse(rule.expr or ""), _local(now))
    return fired is not None and fired > _local(last)


def next_check(rule: Rule | None, last: datetime | None, now: datetime) -> datetime | None:
    """When the scheduler will next check (aware UTC), None without a schedule.
    The scheduler ticks every minute, so the actual check can be up to a minute later."""
    if rule is None:
        return None
    if rule.hours is not None:
        return now if last is None else max(now, last + timedelta(hours=rule.hours))
    if is_due(rule, last, now):
        return now
    fire = cron.next_fire(cron.parse(rule.expr or ""), _local(now))
    return _aware(fire) if fire is not None else None


def due(monitors: list[MonitorTiming], project: Rule | None, now: datetime) -> tuple[list[int], str]:
    """The enabled monitors to check now, and the run's trigger: `interval` when only
    the project's interval is due, else `schedule`."""
    ids: list[int] = []
    cron_due = False
    for m in monitors:
        rule = effective_rule(m.schedule, project)
        if rule is not None and is_due(rule, m.last, now):
            ids.append(m.id)
            cron_due = cron_due or rule.expr is not None
    return ids, "schedule" if cron_due else "interval"


def upcoming(expr: str, now: datetime, count: int = 3) -> list[datetime]:
    """The next `count` fire times of a cron expression (aware UTC); CronError if invalid."""
    return [_aware(t) for t in cron.upcoming(cron.parse(expr), _local(now), count)]
