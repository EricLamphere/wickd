"""Metric monitors' queries and rows, and which monitors a run touched (pure; unit-tested).

- History window (plan 10 decision 3): the first refresh of a monitor (or of a new
  slice) asks for `lookback` periods; later ones only for the trailing
  TRAILING_PERIODS, max(14 periods, the restatement window), so warehouse cost stays
  flat. The stored history fills in the rest.
- Slices (decision 4): one categorical dimension, its top values by total over the
  lookback, recomputed weekly; the series query filters to them with a MetricFlow
  `where`, so other values never count against the row limit.
"""

from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Any

GRAINS = ("day", "week", "month")
DEFAULT_LOOKBACK = {"day": 180, "week": 52, "month": 24}
MAX_LOOKBACK = {"day": 730, "week": 156, "month": 60}
TRAILING_PERIODS = {"day": 35, "week": 14, "month": 14}
SLICE_REFRESH = timedelta(days=7)
TOP_SLICES = 10
MAX_MONITORS = 25
UNSLICED = ""
# A slice value may only hold characters a MetricFlow filter literal can't misread
_UNSAFE_IN_LITERAL = ("{", "}", "%", "#", ";", "--", "/*", "*/", "//", "\\", "\n", "\r")


# ── periods ──────────────────────────────────────────────────────────────────


def period_start(day: date, grain: str) -> date:
    if grain == "week":
        return day - timedelta(days=day.weekday())
    if grain == "month":
        return day.replace(day=1)
    return day


def shift(period: date, grain: str, n: int) -> date:
    if grain == "day":
        return period + timedelta(days=n)
    if grain == "week":
        return period + timedelta(weeks=n)
    months = period.year * 12 + period.month - 1 + n
    return date(months // 12, months % 12 + 1, 1)


def period_ended(period: str, grain: str, at: datetime) -> bool:
    """Whether `at` is after the period (its start date as 'YYYY-MM-DD') ended."""
    end = shift(date.fromisoformat(period), grain, 1)
    return at.date() >= end


def window_start(today: date, grain: str, lookback: int, *, has_history: bool) -> date:
    periods = min(lookback, TRAILING_PERIODS[grain]) if has_history else lookback
    return shift(period_start(today, grain), grain, -periods)


def time_dimension(grain: str) -> str:
    return f"metric_time__{grain}"


# ── queries ──────────────────────────────────────────────────────────────────


def _literal(value: Any) -> str | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return repr(value)
    text = str(value)
    if any(token in text for token in _UNSAFE_IN_LITERAL):
        return None
    return "'" + text.replace("'", "''") + "'"


def filterable_slices(slices: Iterable[Any]) -> list[Any]:
    """The slices that can be written into a filter (others are dropped)."""
    return [s for s in slices if _literal(s) is not None]


def slice_filter(dimension: str, slices: Sequence[Any]) -> str:
    literals = ", ".join(lit for s in slices if (lit := _literal(s)) is not None)
    return f"{{{{ Dimension('{dimension}') }}}} in ({literals})"


def series_query(metric: str, grain: str, dimension: str | None, slices: Sequence[Any], start: date) -> dict:
    query: dict[str, Any] = {
        "metrics": [metric],
        "group_by": [time_dimension(grain), *([dimension] if dimension else [])],
        "start": start.isoformat(),
    }
    if dimension:
        query["where"] = [slice_filter(dimension, slices)]
    return query


def totals_query(metric: str, dimension: str, start: date) -> dict:
    return {"metrics": [metric], "group_by": [dimension], "start": start.isoformat()}


# ── rows ─────────────────────────────────────────────────────────────────────


def slice_key(value: Any) -> str:
    return UNSLICED if value is None else str(value)


def _column(columns: Sequence[str], name: str) -> int | None:
    """Index of `name` (warehouses may change case; MetricFlow may prefix the dimension)."""
    lowered = [c.lower() for c in columns]
    if name.lower() in lowered:
        return lowered.index(name.lower())
    tail = name.lower().split("__")[-1]
    hits = [i for i, c in enumerate(lowered) if c.split("__")[-1] == tail]
    return hits[0] if len(hits) == 1 else None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    try:
        return float(str(value))
    except ValueError:
        return None


def parse_series(
    columns: Sequence[str], rows: Sequence[Sequence[Any]], metric: str, grain: str, dimension: str | None
) -> dict[str, list[tuple[str, float | None]]]:
    """{slice key: [(period 'YYYY-MM-DD', value)]}; ValueError when the columns aren't there."""
    time_i, metric_i = _column(columns, time_dimension(grain)), _column(columns, metric)
    dim_i = _column(columns, dimension) if dimension else None
    if time_i is None or metric_i is None or (dimension and dim_i is None):
        raise ValueError(f"unexpected columns in the result: {', '.join(columns)}")
    out: dict[str, list[tuple[str, float | None]]] = {}
    for row in rows:
        raw = row[time_i]
        if not isinstance(raw, str | date) or len(str(raw)) < 10:
            continue
        key = slice_key(row[dim_i]) if dim_i is not None else UNSLICED
        out.setdefault(key, []).append((str(raw)[:10], _number(row[metric_i])))
    return out


def parse_totals(
    columns: Sequence[str], rows: Sequence[Sequence[Any]], metric: str, dimension: str
) -> list[dict[str, Any]]:
    dim_i, metric_i = _column(columns, dimension), _column(columns, metric)
    if dim_i is None or metric_i is None:
        raise ValueError(f"unexpected columns in the result: {', '.join(columns)}")
    return [{"slice": row[dim_i], "total": _number(row[metric_i])} for row in rows]


# ── which monitors a run touched ─────────────────────────────────────────────


def affected_monitors(
    monitors: Iterable[tuple[int, str]],
    metric_uids: Mapping[str, str],
    parents: Mapping[str, Sequence[str]],
    run_nodes: set[str],
) -> list[int]:
    """Ids of monitors whose metric has one of `run_nodes` upstream (a parent_map walk)."""
    out = []
    for monitor_id, metric in monitors:
        uid = metric_uids.get(metric)
        if uid is not None and not run_nodes.isdisjoint(ancestors(uid, parents)):
            out.append(monitor_id)
    return out


def ancestors(unique_id: str, parents: Mapping[str, Sequence[str]]) -> set[str]:
    seen: set[str] = set()
    stack = list(parents.get(unique_id, ()))
    while stack:
        node = stack.pop()
        if node not in seen:
            seen.add(node)
            stack.extend(parents.get(node, ()))
    return seen
