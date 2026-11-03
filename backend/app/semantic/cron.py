"""Five-field cron expressions for metric monitor schedules (pure, no dependencies).

`minute hour day-of-month month day-of-week`, with `*`, values, ranges `a-b`, steps
`*/n` / `a-b/n` / `a/n`, lists, month and weekday names (jan, mon, …; 0 and 7 are
Sunday) and the macros @hourly @daily @midnight @weekly @monthly @yearly @annually.
Like Vixie cron, when both day fields are restricted a day matches either of them.

Times are naive wall-clock times (wickd passes the machine's local time, so a
schedule follows daylight saving). Schedules that fire more often than every
MIN_GAP_MINUTES are refused: every check queries the warehouse.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from itertools import pairwise

MIN_GAP_MINUTES = 15
_SEARCH_DAYS = 366 * 8 + 2  # Feb 29 can be 8 years away

MACROS = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
}
_MONTHS = {n: i for i, n in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1
)}
_DAYS = {n: i for i, n in enumerate(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])}
_FIELDS = (  # name, low, high, names
    ("minute", 0, 59, {}),
    ("hour", 0, 23, {}),
    ("day of month", 1, 31, {}),
    ("month", 1, 12, _MONTHS),
    ("day of week", 0, 7, _DAYS),
)


class CronError(ValueError):
    """The expression isn't a valid (or allowed) schedule; the message is user-facing."""


@dataclass(frozen=True)
class Cron:
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]  # 0 = Sunday
    any_day: bool  # day of month is `*`
    any_weekday: bool  # day of week is `*`

    def matches_day(self, d: datetime) -> bool:
        if d.month not in self.months:
            return False
        dom = d.day in self.days
        dow = (d.isoweekday() % 7) in self.weekdays
        if self.any_day or self.any_weekday:
            return dom and dow
        return dom or dow


def _value(text: str, field: str, low: int, high: int, names: dict[str, int]) -> int:
    key = text.lower()
    if key in names:
        return names[key]
    if not text.isdigit():
        raise CronError(f"`{text}` isn't a valid {field}")
    value = int(text)
    if not low <= value <= high:
        raise CronError(f"{field} must be between {low} and {high}, not {value}")
    return value


def _field(text: str, field: str, low: int, high: int, names: dict[str, int]) -> frozenset[int]:
    values: set[int] = set()
    for part in text.split(","):
        if not part:
            raise CronError(f"empty value in the {field} field")
        base, _, step_text = part.partition("/")
        step = 1
        if step_text:
            if not step_text.isdigit() or int(step_text) < 1:
                raise CronError(f"`{step_text}` isn't a valid step in the {field} field")
            step = int(step_text)
        if base == "*":
            start, end = low, high
        elif "-" in base:
            a, _, b = base.partition("-")
            start, end = _value(a, field, low, high, names), _value(b, field, low, high, names)
            if start > end:
                raise CronError(f"range `{base}` runs backwards in the {field} field")
        else:
            start = _value(base, field, low, high, names)
            end = high if step_text else start
        values.update(range(start, end + 1, step))
    return frozenset(values)


def _too_frequent(minutes: frozenset[int], hours: frozenset[int]) -> bool:
    ordered = sorted(minutes)
    gaps = [b - a for a, b in pairwise(ordered)]
    if any((h + 1) % 24 in hours for h in hours):  # the last minute of an hour → the first of the next
        gaps.append(ordered[0] + 60 - ordered[-1])
    return bool(gaps) and min(gaps) < MIN_GAP_MINUTES


def parse(expr: str) -> Cron:
    text = " ".join((expr or "").split())
    text = MACROS.get(text.lower(), text)
    parts = text.split(" ")
    if len(parts) != 5:
        raise CronError("a schedule has 5 fields: minute hour day-of-month month day-of-week")
    parsed = [_field(p, name, low, high, names) for p, (name, low, high, names) in zip(parts, _FIELDS, strict=True)]
    minutes, hours, days, months, weekdays = parsed
    weekdays = frozenset(d % 7 for d in weekdays)
    if _too_frequent(minutes, hours):
        raise CronError(f"checks can run at most every {MIN_GAP_MINUTES} minutes")
    cron = Cron(minutes, hours, days, months, weekdays, parts[2] == "*", parts[4] == "*")
    if next_fire(cron, datetime(2000, 1, 1)) is None:
        raise CronError("this schedule never runs")
    return cron


def normalize(expr: str) -> str:
    """The expression as stored: validated, whitespace collapsed, macros kept lowercase."""
    parse(expr)
    text = " ".join(expr.split())
    return text.lower() if text.lower() in MACROS else text


def _day_start(d: datetime) -> datetime:
    return d.replace(hour=0, minute=0, second=0, microsecond=0)


def previous_fire(cron: Cron, now: datetime) -> datetime | None:
    """The latest time at or before `now` (to the minute) the schedule fires."""
    bound = now.replace(second=0, microsecond=0)
    day = _day_start(bound)
    for offset in range(_SEARCH_DAYS):
        d = day - timedelta(days=offset)
        if not cron.matches_day(d):
            continue
        limit = (bound.hour, bound.minute) if offset == 0 else (23, 59)
        times = [(h, m) for h in cron.hours for m in cron.minutes if (h, m) <= limit]
        if times:
            h, m = max(times)
            return d.replace(hour=h, minute=m)
    return None


def next_fire(cron: Cron, after: datetime) -> datetime | None:
    """The first time strictly after `after` (to the minute) the schedule fires."""
    bound = after.replace(second=0, microsecond=0)
    day = _day_start(bound)
    for offset in range(_SEARCH_DAYS):
        d = day + timedelta(days=offset)
        if not cron.matches_day(d):
            continue
        times = [(h, m) for h in cron.hours for m in cron.minutes
                 if offset > 0 or (h, m) > (bound.hour, bound.minute)]
        if times:
            h, m = min(times)
            return d.replace(hour=h, minute=m)
    return None


def upcoming(cron: Cron, after: datetime, count: int) -> list[datetime]:
    out: list[datetime] = []
    cursor = after
    while len(out) < count:
        nxt = next_fire(cron, cursor)
        if nxt is None:
            break
        out.append(nxt)
        cursor = nxt
    return out
