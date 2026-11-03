"""Cron expressions for metric monitor schedules (app/semantic/cron.py)."""

from datetime import datetime

import pytest

from app.semantic import cron


def at(text: str) -> datetime:
    return datetime.fromisoformat(text)


@pytest.mark.parametrize(("expr", "after", "expected"), [
    ("0 9 * * *", "2026-11-01T08:59", "2026-11-01T09:00"),
    ("0 9 * * *", "2026-11-01T09:00", "2026-11-02T09:00"),  # strictly after
    ("*/15 * * * *", "2026-11-01T10:07", "2026-11-01T10:15"),
    ("30 8 * * mon-fri", "2026-10-31T12:00", "2026-11-02T08:30"),  # Saturday → Monday
    ("0 0 1 * *", "2026-11-15T00:00", "2026-12-01T00:00"),
    ("0 6 * jan,jul *", "2026-11-01T00:00", "2027-01-01T06:00"),
    ("0 0 * * 7", "2026-11-02T00:00", "2026-11-08T00:00"),  # 7 = Sunday
    ("0 0 29 2 *", "2026-01-01T00:00", "2028-02-29T00:00"),
    ("@hourly", "2026-11-01T10:30", "2026-11-01T11:00"),
    ("@weekly", "2026-11-02T00:00", "2026-11-08T00:00"),
    ("0 12 1-10/3 * *", "2026-11-02T00:00", "2026-11-04T12:00"),
])
def test_next_fire(expr: str, after: str, expected: str) -> None:
    assert cron.next_fire(cron.parse(expr), at(after)) == at(expected)


def test_day_fields_match_either_when_both_restricted() -> None:
    c = cron.parse("0 0 13 * fri")  # the 13th or any Friday
    assert cron.next_fire(c, at("2026-11-01T00:00")) == at("2026-11-06T00:00")  # Friday
    assert cron.next_fire(c, at("2026-11-10T00:00")) == at("2026-11-13T00:00")  # 13th (also a Friday)
    assert cron.next_fire(c, at("2026-11-21T00:00")) == at("2026-11-27T00:00")


@pytest.mark.parametrize(("expr", "now", "expected"), [
    ("0 9 * * *", "2026-11-01T09:00:30", "2026-11-01T09:00"),  # at the minute counts
    ("0 9 * * *", "2026-11-01T08:59", "2026-10-31T09:00"),
    ("0 9,17 * * mon-fri", "2026-11-01T12:00", "2026-10-30T17:00"),  # Sunday → Friday
    ("0 0 29 2 *", "2027-06-01T00:00", "2024-02-29T00:00"),
])
def test_previous_fire(expr: str, now: str, expected: str) -> None:
    assert cron.previous_fire(cron.parse(expr), at(now)) == at(expected)


def test_upcoming() -> None:
    times = cron.upcoming(cron.parse("0 */6 * * *"), at("2026-11-01T05:00"), 3)
    assert times == [at("2026-11-01T06:00"), at("2026-11-01T12:00"), at("2026-11-01T18:00")]


@pytest.mark.parametrize(("expr", "message"), [
    ("", "5 fields"),
    ("0 9 * *", "5 fields"),
    ("60 * * * *", "minute must be between 0 and 59"),
    ("0 24 * * *", "hour must be between 0 and 23"),
    ("0 0 0 * *", "day of month must be between 1 and 31"),
    ("0 0 * foo *", "isn't a valid month"),
    ("0 0 * * 8", "day of week must be between 0 and 7"),
    ("5-1 * * * *", "runs backwards"),
    ("*/0 * * * *", "isn't a valid step"),
    ("0,,5 * * * *", "empty value"),
    ("0 0 30 2 *", "never runs"),
    ("* * * * *", "at most every 15 minutes"),
    ("*/5 9 * * *", "at most every 15 minutes"),
    ("0,59 * * * *", "at most every 15 minutes"),  # 10:59 → 11:00
])
def test_invalid(expr: str, message: str) -> None:
    with pytest.raises(cron.CronError, match=message):
        cron.parse(expr)


@pytest.mark.parametrize("expr", ["*/15 * * * *", "0,59 9,17 * * *", "0 * * * *", "45 23 * * *"])
def test_frequent_but_allowed(expr: str) -> None:
    cron.parse(expr)


def test_normalize() -> None:
    assert cron.normalize("  0   9 * *   MON ") == "0 9 * * MON"
    assert cron.normalize("@Daily") == "@daily"
    with pytest.raises(cron.CronError):
        cron.normalize("nope")
