"""When metric monitors check themselves while wickd is open (pure, unit-tested).

A project has at most one automatic schedule: every N hours (`MONITOR_INTERVAL_HOURS`)
or a cron expression (`MONITOR_SCHEDULE`, see app/scheduling/cron.py). A monitor can override it with
its own cron expression or `off` (`metric_monitors.schedule`; NULL follows the project).

Due is decided per monitor from its last check (or last scheduled attempt, so a failing
refresh isn't retried every tick): an interval is due once N hours have passed; a cron
schedule is due when it fired since then. A cron time missed while wickd was closed is
therefore checked once when it next opens. Cron times are the machine's local time.
The generic rules live in app/scheduling/rules.py; this module layers the project
schedule and per-monitor overrides on top.
"""

from dataclasses import dataclass
from datetime import datetime

from app.scheduling import cron
from app.scheduling.rules import (  # noqa: F401 — re-exported for monitor callers
    MAX_INTERVAL_HOURS,
    MIN_INTERVAL_HOURS,
    Rule,
    is_due,
    next_check,
    parse_interval,
    parse_schedule,
    upcoming,
)

INTERVAL_KEY = "MONITOR_INTERVAL_HOURS"
SCHEDULE_KEY = "MONITOR_SCHEDULE"
OFF = "off"


@dataclass(frozen=True)
class MonitorTiming:
    id: int
    schedule: str | None  # the monitor's override: None (project), "off" or cron
    last: datetime | None  # aware: last check or scheduled attempt, whichever is later


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
