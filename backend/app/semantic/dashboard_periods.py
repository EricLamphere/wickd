"""Dashboard periods (plan 12): a current period and the one it's compared with. Pure.

Presets are stored relative ("last_30_days"), so a dashboard stays current; they resolve
against `today` to explicit dates ending yesterday — today is still filling in, so including it
would drag every total down (a to-date preset on its period's first day is today alone).
Mirrored by the frontend's dashboards/periods.ts. `previous_period` is the same number of days right
before the current period, `previous_year` the same dates a year earlier. `grain: auto`
follows the current period's length. `all_time` has no dates and no comparison.
"""

from dataclasses import dataclass
from datetime import date, timedelta

from app.semantic.dashboards import DateRange

GRAINS = ("day", "week", "month", "quarter", "year")


@dataclass(frozen=True)
class Range:
    start: date
    end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def to_dict(self) -> dict[str, str]:
        return {"start": self.start.isoformat(), "end": self.end.isoformat()}


def _year_ago(d: date) -> date:
    try:
        return d.replace(year=d.year - 1)
    except ValueError:  # Feb 29
        return d.replace(year=d.year - 1, day=28)


def _quarter_start(d: date) -> date:
    return date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)


def resolve_current(current: str | DateRange, today: date) -> Range | None:
    """Explicit dates for the current period (None = all time)."""
    if isinstance(current, DateRange):
        return Range(date.fromisoformat(current.start), date.fromisoformat(current.end))
    end = today - timedelta(days=1)
    days = {"last_7_days": 7, "last_30_days": 30, "last_90_days": 90}
    if current in days:
        return Range(end - timedelta(days=days[current] - 1), end)
    if current == "last_12_months":
        return Range(_year_ago(end) + timedelta(days=1), end)
    to_date = {
        "month_to_date": today.replace(day=1),
        "quarter_to_date": _quarter_start(today),
        "year_to_date": date(today.year, 1, 1),
    }
    if current in to_date:
        start = to_date[current]
        return Range(start, max(start, end))  # the period's first day: today alone
    if current == "last_month":
        end = today.replace(day=1) - timedelta(days=1)
        return Range(end.replace(day=1), end)
    if current == "last_quarter":
        end = _quarter_start(today) - timedelta(days=1)
        return Range(_quarter_start(end), end)
    return None


def resolve_compare(compare: str | DateRange, current: Range | None) -> Range | None:
    if current is None or compare == "none":
        return None
    if isinstance(compare, DateRange):
        return Range(date.fromisoformat(compare.start), date.fromisoformat(compare.end))
    if compare == "previous_year":
        return Range(_year_ago(current.start), _year_ago(current.end))
    end = current.start - timedelta(days=1)
    return Range(end - timedelta(days=current.days - 1), end)


def auto_grain(current: Range | None) -> str:
    if current is None:
        return "month"
    if current.days <= 31:
        return "day"
    if current.days <= 180:
        return "week"
    if current.days <= 3 * 366:
        return "month"
    return "quarter"
