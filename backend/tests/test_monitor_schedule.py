"""Which metric monitors are due on the scheduler's tick (app/semantic/monitor_schedule.py).

Cron times are local wall-clock times, so these tests build instants from local times."""

from datetime import UTC, datetime, timedelta

import pytest

from app.scheduling import cron
from app.semantic import monitor_schedule as ms


def local(text: str) -> datetime:
    """A local wall-clock time as an aware UTC instant."""
    return datetime.fromisoformat(text).astimezone().astimezone(UTC)


def test_project_rule() -> None:
    assert ms.project_rule(None, None) is None
    assert ms.project_rule("0", None) is None
    assert ms.project_rule("6", None) == ms.Rule(source="project", hours=6)
    assert ms.project_rule("6", "0 9 * * *") == ms.Rule(source="project", expr="0 9 * * *")
    assert ms.project_rule("6", "garbage") == ms.Rule(source="project", hours=6)


def test_check_override() -> None:
    assert ms.check_override(None) is None
    assert ms.check_override("  ") is None
    assert ms.check_override("OFF") == "off"
    assert ms.check_override(" 0  9 * * * ") == "0 9 * * *"
    with pytest.raises(cron.CronError):
        ms.check_override("* * * * *")


def test_effective_rule() -> None:
    project = ms.Rule(source="project", hours=6)
    assert ms.effective_rule(None, project) == project
    assert ms.effective_rule("off", project) is None
    assert ms.effective_rule("0 9 * * *", project) == ms.Rule(source="monitor", expr="0 9 * * *")
    assert ms.effective_rule("0 9 * * *", None) == ms.Rule(source="monitor", expr="0 9 * * *")


def test_interval_due() -> None:
    rule = ms.Rule(source="project", hours=6)
    now = datetime(2026, 11, 1, 12, tzinfo=UTC)
    assert ms.is_due(rule, None, now)
    assert not ms.is_due(rule, now - timedelta(hours=5), now)
    assert ms.is_due(rule, now - timedelta(hours=6), now)
    assert ms.next_check(rule, now - timedelta(hours=5), now) == now + timedelta(hours=1)
    assert ms.next_check(rule, None, now) == now


def test_cron_due_once_per_fire() -> None:
    rule = ms.Rule(source="project", expr="0 9 * * *")
    assert not ms.is_due(rule, local("2026-11-01T08:00"), local("2026-11-01T08:59"))
    assert ms.is_due(rule, local("2026-11-01T08:00"), local("2026-11-01T09:00"))
    assert not ms.is_due(rule, local("2026-11-01T09:00:20"), local("2026-11-01T09:01"))  # already checked
    # wickd closed overnight: the missed 9:00 is checked once on opening
    assert ms.is_due(rule, local("2026-10-30T09:00:20"), local("2026-11-01T14:00"))
    assert ms.next_check(rule, local("2026-11-01T09:00:20"), local("2026-11-01T10:00")) == local("2026-11-02T09:00")


def test_due_mixes_project_and_overrides() -> None:
    now = local("2026-11-01T09:00")
    long_ago = now - timedelta(days=2)
    monitors = [
        ms.MonitorTiming(id=1, schedule=None, last=long_ago),  # project interval: due
        ms.MonitorTiming(id=2, schedule="off", last=long_ago),  # never
        ms.MonitorTiming(id=3, schedule="0 9 * * *", last=long_ago),  # own cron: due
        ms.MonitorTiming(id=4, schedule="0 10 * * *", last=now - timedelta(minutes=30)),  # not yet
        ms.MonitorTiming(id=5, schedule=None, last=now - timedelta(hours=1)),  # checked recently
    ]
    assert ms.due(monitors, ms.Rule(source="project", hours=6), now) == ([1, 3], "schedule")
    assert ms.due(monitors[:1], ms.Rule(source="project", hours=6), now) == ([1], "interval")
    assert ms.due(monitors, None, now) == ([3], "schedule")


def test_upcoming() -> None:
    times = ms.upcoming("0 9 * * *", local("2026-11-01T10:00"), 2)
    assert times == [local("2026-11-02T09:00"), local("2026-11-03T09:00")]
