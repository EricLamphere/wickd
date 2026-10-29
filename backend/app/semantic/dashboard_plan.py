"""Which MetricFlow queries a dashboard widget needs (plan 12). Pure; tested in test_dashboards.py.

Each widget becomes a few queries, each with a role, all run in the dashboard's one batch:

| widget      | roles (the *_previous ones only while comparing)                  |
|-------------|--------------------------------------------------------------------|
| summary     | total, total_previous, trend, trend_previous (trend when enabled)  |
| timeseries  | current, previous: metric_time at the grain (+ split dimension)    |
| bar         | current, previous: by category (+ stack dimension, never compared) |
| table       | current, previous: by its dimensions (previous when comparing)    |
| leaderboard | current (top N), previous (all values, matched by key)             |
| text        | none                                                               |

A summary's total is its own query, never the sum of its trend (wrong for ratios and
averages). Dashboard filters are ANDed with the widget's, but only where every name a
filter references is a group-by of all the widget's metrics; elsewhere it's skipped
with a note. The widget's period override replaces the dashboard's per key.
"""

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from app.semantic.dashboard_periods import Range, auto_grain, resolve_compare, resolve_current
from app.semantic.dashboards import Dashboard, Grain, Widget, validation_message

_REFERENCE = re.compile(r"\{\{\s*(?:Dimension|TimeDimension|Entity)\(\s*['\"](\w+)['\"]")
METRIC_TIME = "metric_time"
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Layout = Literal["auto", "combined", "separate"]


class WidgetBroken(ValueError):
    """The widget can't be queried (a metric is gone, an option is invalid, …)."""


class _Options(BaseModel):
    model_config = ConfigDict(extra="allow")


class SummaryOptions(_Options):
    format: Literal["number", "currency", "percent"] = "number"
    decimals: int | None = Field(default=None, ge=0, le=6)
    higher_is_better: bool = True
    trend: bool = True


class TimeseriesOptions(_Options):
    style: Literal["line", "area", "stacked"] = "line"
    grain: Grain = "auto"  # auto = the dashboard's grain
    split_by: Name | None = None
    top_n: int = Field(default=5, ge=1, le=20)
    zero_baseline: bool = True
    layout: Layout = "auto"


class BarOptions(_Options):
    dimension: Name | None = None
    orientation: Literal["vertical", "horizontal"] = "vertical"
    sort: Literal["value", "name"] = "value"
    top_n: int = Field(default=10, ge=1, le=50)
    stack_by: Name | None = None
    layout: Layout = "auto"


class TableOptions(_Options):
    dimensions: list[Name] = Field(default_factory=list, max_length=5)
    compare_columns: bool = True
    limit: int = Field(default=50, ge=1, le=500)


class LeaderboardOptions(_Options):
    dimension: Name | None = None
    top_n: int = Field(default=10, ge=1, le=50)
    show_change: bool = True


class TextOptions(_Options):
    body: Annotated[str, StringConstraints(max_length=5000)] = ""


OPTION_MODELS: dict[str, type[_Options]] = {
    "summary": SummaryOptions, "timeseries": TimeseriesOptions, "bar": BarOptions,
    "table": TableOptions, "leaderboard": LeaderboardOptions, "text": TextOptions,
}


@dataclass(frozen=True)
class QueryPlan:
    role: str
    query: dict[str, Any]


@dataclass(frozen=True)
class WidgetPlan:
    widget_id: str
    queries: tuple[QueryPlan, ...]
    current: Range | None
    previous: Range | None
    grain: str
    notes: tuple[str, ...] = field(default_factory=tuple)
    # a non-text widget without metrics yet ("drag a metric here")
    empty: bool = False


# ── names a widget's metrics share ────────────────────────────────────────────


def referenced_names(where: str) -> set[str]:
    return set(_REFERENCE.findall(where))


def _base(dim: Mapping[str, Any]) -> str:
    name = str(dim.get("name") or "")
    grain = dim.get("time_granularity")
    suffix = f"__{grain}" if grain else ""
    return name[: -len(suffix)] if dim.get("type") == "time" and suffix and name.endswith(suffix) else name


def _names_for(metric: Mapping[str, Any]) -> set[str]:
    """A metric's group-by names, plus the entities they hang off (customer for customer__region)."""
    names = {_base(d) for d in metric.get("dimensions") or []}
    entities = {n.split("__", 1)[0] for n in names if "__" in n}
    return names | entities | {METRIC_TIME}


def shared_names(catalog: Mapping[str, Any], metrics: Iterable[str]) -> set[str]:
    by_name = {m.get("name"): m for m in catalog.get("metrics") or []}
    sets = [_names_for(by_name[m]) for m in metrics if m in by_name]
    return set.intersection(*sets) if sets else set()


# ── planning ──────────────────────────────────────────────────────────────────


def options_for(widget: Widget) -> _Options:
    try:
        return OPTION_MODELS[widget.type].model_validate(widget.options)
    except ValidationError as exc:
        raise WidgetBroken(f"invalid options: {validation_message(exc)}") from exc


def _check_metrics(widget: Widget, catalog: Mapping[str, Any]) -> None:
    known = {m.get("name") for m in catalog.get("metrics") or []}
    missing = [m for m in widget.metrics if m not in known]
    if missing:
        noun, verb = ("metric", "no longer exists") if len(missing) == 1 else ("metrics", "no longer exist")
        raise WidgetBroken(f"{noun} {', '.join(f'`{m}`' for m in missing)} {verb} — remove it from the widget")


def _check_dimensions(names: Iterable[str | None], available: set[str]) -> None:
    for name in names:
        if name and name not in available:
            raise WidgetBroken(f"`{name}` isn't a dimension of every metric in this widget")


def _periods(widget: Widget, dashboard: Dashboard, today: date) -> tuple[Range | None, Range | None]:
    override = widget.period
    current_spec = override.current if override and override.current is not None else dashboard.period.current
    compare_spec = override.compare if override and override.compare is not None else dashboard.period.compare
    current = resolve_current(current_spec, today)
    return current, resolve_compare(compare_spec, current)


def _filters(widget: Widget, dashboard: Dashboard, available: set[str]) -> tuple[list[str], list[str]]:
    """(the widget's where list, notes about dashboard filters that don't apply)."""
    notes: list[str] = []
    applied: list[str] = []
    for where in dashboard.filters:
        missing = sorted(referenced_names(where) - available)
        if missing:
            notes.append(f"dashboard filter on {', '.join(f'`{m}`' for m in missing)} doesn't apply to this widget")
        else:
            applied.append(where)
    return [*applied, *widget.filters], notes


def _query(metrics: list[str], where: list[str], period: Range | None, group_by: list[str] | None = None,
           order_by: list[str] | None = None, limit: int | None = None) -> dict[str, Any]:
    q: dict[str, Any] = {"metrics": metrics}
    if group_by:
        q["group_by"] = group_by
    if where:
        q["where"] = where
    if order_by:
        q["order_by"] = order_by
    if limit:
        q["limit"] = limit
    if period:
        q["start"], q["end"] = period.start.isoformat(), period.end.isoformat()
    return q


def _pair(role: str, metrics: list[str], where: list[str], current: Range | None, previous: Range | None,
          **kw: Any) -> list[QueryPlan]:
    """`role` for the current period and `<role>_previous` for the comparison (no limit there:
    its values are matched to the current ones by key)."""
    plans = [QueryPlan(role, _query(metrics, where, current, **kw))]
    if previous is not None:
        plans.append(QueryPlan(f"{role}_previous", _query(metrics, where, previous, **{**kw, "limit": None})))
    return plans


def plan_widget(widget: Widget, dashboard: Dashboard, catalog: Mapping[str, Any], today: date) -> WidgetPlan:
    """The widget's queries with the dashboard's period and filters merged in; WidgetBroken if it can't run."""
    options = options_for(widget)
    current, previous = _periods(widget, dashboard, today)
    dashboard_grain = dashboard.grain if dashboard.grain != "auto" else auto_grain(current)
    if widget.type == "text" or not widget.metrics:
        return WidgetPlan(widget.id, (), current, previous, dashboard_grain, empty=widget.type != "text")
    _check_metrics(widget, catalog)
    available = shared_names(catalog, widget.metrics)
    where, notes = _filters(widget, dashboard, available)
    metrics = list(widget.metrics)
    time = f"{METRIC_TIME}__{dashboard_grain}"
    queries: list[QueryPlan] = []
    grain = dashboard_grain

    if isinstance(options, SummaryOptions):
        queries += _pair("total", metrics, where, current, previous)
        if options.trend:
            queries += _pair("trend", metrics, where, current, previous, group_by=[time])
    elif isinstance(options, TimeseriesOptions):
        grain = options.grain if options.grain != "auto" else dashboard_grain
        _check_dimensions([options.split_by], available)
        group_by = [f"{METRIC_TIME}__{grain}", *([options.split_by] if options.split_by else [])]
        queries += _pair("current", metrics, where, current, previous, group_by=group_by)
    elif isinstance(options, BarOptions):
        if not options.dimension:
            raise WidgetBroken("pick a dimension to break the bars down by")
        _check_dimensions([options.dimension, options.stack_by], available)
        if options.stack_by:
            group_by = [options.dimension, options.stack_by]
            queries.append(QueryPlan("current", _query(metrics, where, current, group_by=group_by)))
            if previous is not None:
                notes.append("the comparison isn't shown on stacked bars")
        else:
            queries += _pair("current", metrics, where, current, previous, group_by=[options.dimension],
                             order_by=[f"-{metrics[0]}"], limit=options.top_n)
    elif isinstance(options, TableOptions):
        _check_dimensions(options.dimensions, available)
        compare = previous if options.compare_columns else None
        queries += _pair("current", metrics, where, current, compare, group_by=list(options.dimensions) or None,
                         order_by=[f"-{metrics[0]}"] if options.dimensions else None,
                         limit=options.limit if options.dimensions else None)
    elif isinstance(options, LeaderboardOptions):
        if not options.dimension:
            raise WidgetBroken("pick a dimension to rank")
        _check_dimensions([options.dimension], available)
        compare = previous if options.show_change else None
        queries += _pair("current", metrics[:1], where, current, compare, group_by=[options.dimension],
                         order_by=[f"-{metrics[0]}"], limit=options.top_n)
    return WidgetPlan(widget.id, tuple(queries), current, previous, grain, tuple(notes))
