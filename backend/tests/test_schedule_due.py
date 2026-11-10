"""Which scheduled runs are due on the scheduler's tick (app/runs/schedule_due.py).

Cron times are local wall-clock times, so these tests build instants from local times."""

from datetime import UTC, datetime, timedelta

from app.runs import schedule_due as sd
from app.scheduling.rules import Rule


def local(text: str) -> datetime:
    """A local wall-clock time as an aware UTC instant."""
    return datetime.fromisoformat(text).astimezone().astimezone(UTC)


WEEKDAYS_7 = Rule(expr="0 7 * * 1-5")
EVERY_6H = Rule(hours=6)


def timing(rule: Rule | None, since: datetime | None, **kw: object) -> sd.ScheduleTiming:
    return sd.ScheduleTiming(id=1, rule=rule, since=since, **kw)  # type: ignore[arg-type]


def test_rule_for() -> None:
    assert sd.rule_for(None, None) is None
    assert sd.rule_for(6, None) == Rule(hours=6)
    assert sd.rule_for(0, None) is None
    assert sd.rule_for(6, "0 7 * * *") == Rule(expr="0 7 * * *")  # cron wins
    assert sd.rule_for(6, "garbage") == Rule(hours=6)
    assert sd.rule_for(None, "garbage") is None


def test_interval_due_after_n_hours() -> None:
    now = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
    assert sd.due([timing(EVERY_6H, now - timedelta(hours=5))], now) == []
    assert sd.due([timing(EVERY_6H, now - timedelta(hours=6))], now) == [
        sd.Due(id=1, outcome="run", scheduled_for=now)
    ]


def test_cron_due_when_it_fired_since() -> None:
    # Tuesday 2026-11-10
    assert sd.due([timing(WEEKDAYS_7, local("2026-11-10T06:00"))], local("2026-11-10T06:59")) == []
    assert sd.due([timing(WEEKDAYS_7, local("2026-11-10T06:00"))], local("2026-11-10T07:00")) == [
        sd.Due(id=1, outcome="run", scheduled_for=local("2026-11-10T07:00"))
    ]
    # already fired at 07:00:10 → not due again at 07:01
    assert sd.due([timing(WEEKDAYS_7, local("2026-11-10T07:00:10"))], local("2026-11-10T07:01")) == []


def test_missed_cron_without_catch_up() -> None:
    # wickd was closed over the 07:00 run and opened at 09:30
    due = sd.due([timing(WEEKDAYS_7, local("2026-11-09T07:00:05"))], local("2026-11-10T09:30"))
    assert due == [sd.Due(id=1, outcome="missed", scheduled_for=local("2026-11-10T07:00"))]


def test_missed_cron_with_catch_up_runs_once() -> None:
    due = sd.due([timing(WEEKDAYS_7, local("2026-11-06T07:00:05"), catch_up=True)], local("2026-11-10T09:30"))
    assert due == [sd.Due(id=1, outcome="run", scheduled_for=local("2026-11-10T07:00"))]


def test_within_grace_is_not_missed() -> None:
    # the loop ticks every minute and starts a minute after launch: a few minutes late still runs
    due = sd.due([timing(WEEKDAYS_7, local("2026-11-09T07:00:05"))], local("2026-11-10T07:03"))
    assert due[0].outcome == "run"


def test_missed_interval() -> None:
    now = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
    assert sd.due([timing(EVERY_6H, now - timedelta(hours=9))], now)[0].outcome == "missed"
    assert sd.due([timing(EVERY_6H, now - timedelta(hours=9), catch_up=True)], now)[0].outcome == "run"


def test_inactive_and_off_never_due() -> None:
    now = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
    old = now - timedelta(days=3)
    assert sd.due([timing(EVERY_6H, old, active=False)], now) == []
    assert sd.due([timing(None, old)], now) == []
    assert sd.due([timing(EVERY_6H, None)], now) == []


def test_several_schedules() -> None:
    now = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
    rows = [
        sd.ScheduleTiming(id=1, rule=EVERY_6H, since=now - timedelta(hours=6)),
        sd.ScheduleTiming(id=2, rule=EVERY_6H, since=now - timedelta(hours=1)),
        sd.ScheduleTiming(id=3, rule=EVERY_6H, since=now - timedelta(hours=7)),
    ]
    assert [(d.id, d.outcome) for d in sd.due(rows, now)] == [(1, "run"), (3, "missed")]


def test_dst_fall_back_fires_once() -> None:
    # A daily 07:00 schedule across a DST change still fires once per local day
    rule = Rule(expr="0 7 * * *")
    since = local("2026-10-31T07:00:05")
    assert sd.due([timing(rule, since)], local("2026-11-01T06:59")) == []
    assert sd.due([timing(rule, since)], local("2026-11-01T07:00"))[0].scheduled_for == local("2026-11-01T07:00")


def test_since_for() -> None:
    a = datetime(2026, 11, 1, tzinfo=UTC)
    b = datetime(2026, 11, 2, tzinfo=UTC)
    assert sd.since_for(a, b, None) == b
    assert sd.since_for(None, None, a) == a
    assert sd.since_for(None, None, None) is None
    # naive datetimes from SQLite are UTC
    assert sd.since_for(b.replace(tzinfo=None), a, None) == b


def test_describe() -> None:
    assert sd.describe(None) == "off"
    assert sd.describe(EVERY_6H) == "every 6 h"
    assert sd.describe(Rule(hours=1)) == "every hour"
    assert sd.describe(WEEKDAYS_7) == "cron 0 7 * * 1-5"
