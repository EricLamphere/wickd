"""Dashboard files (semantic/dashboards.py), periods (dashboard_periods.py) and widget query
planning (dashboard_plan.py). Pure."""

from datetime import date
from pathlib import Path

import pytest
import yaml

from app.semantic import dashboards as store
from app.semantic.dashboard_periods import Range, auto_grain, resolve_compare, resolve_current
from app.semantic.dashboard_plan import (
    WidgetBroken,
    plan_widget,
    referenced_names,
    shared_names,
)
from app.semantic.dashboards import Dashboard, DashboardError, DateRange

CATALOG = {
    "metrics": [
        {"name": "revenue", "dimensions": [
            {"name": "customer__region", "type": "categorical", "time_granularity": None},
            {"name": "order__channel", "type": "categorical", "time_granularity": None},
            {"name": "metric_time__day", "type": "time", "time_granularity": "day"},
        ]},
        {"name": "order_count", "dimensions": [
            {"name": "customer__region", "type": "categorical", "time_granularity": None},
            {"name": "order__status", "type": "categorical", "time_granularity": None},
        ]},
    ],
    "saved_queries": [],
}
TODAY = date(2026, 10, 28)
REGION = "{{ Dimension('customer__region') }} = 'north'"
STATUS = "{{ Dimension('order__status') }} = 'paid'"

SAMPLE = """\
version: 1
title: Revenue overview
owner_notes: kept as-is   # unknown key
period: {current: last_30_days, compare: previous_year}
grain: week
filters: ["{{ Dimension('customer__region') }} = 'north'"]
widgets:
  - id: rev
    type: summary
    w: 3
    h: 1
    metrics: [revenue]
    options: {format: currency, color: blue}
  - id: trend
    type: timeseries
    w: 9
    metrics: [revenue, order_count]
    period: {compare: none}
"""


def _dash(widgets: list[dict], **kw) -> Dashboard:
    return Dashboard.model_validate({"title": "D", "widgets": widgets, **kw})


def _plan(widget: dict, **kw):
    d = _dash([{"id": "w", **widget}], **kw)
    return plan_widget(d.widgets[0], d, CATALOG, TODAY)


# ── file schema ──────────────────────────────────────────────────────────────


def test_round_trip_keeps_unknown_keys() -> None:
    d = store.parse(SAMPLE)
    data = yaml.safe_load(store.render(d))
    assert data["owner_notes"] == "kept as-is"
    assert data["widgets"][0]["options"] == {"format": "currency", "color": "blue"}
    assert data["widgets"][1]["period"] == {"compare": "none"}
    assert data["period"] == {"current": "last_30_days", "compare": "previous_year"}
    assert store.parse(store.render(d)) == d


def test_defaults() -> None:
    d = _dash([{"id": "a"}])
    assert (d.period.current, d.period.compare, d.grain, d.canvas_width) == ("last_30_days", "previous_period", "auto", 1200)
    w = d.widgets[0]
    assert (w.type, w.width, w.height, w.metrics) == ("summary", 33.33, 280, [])


def test_legacy_grid_sizes_convert_to_free_sizes() -> None:
    d = store.parse(SAMPLE)  # w: 3 / h: 1 and w: 9 / (default) h
    assert (d.widgets[0].width, d.widgets[0].height) == (25.0, 132)
    assert d.widgets[1].width == 75.0 and d.widgets[1].height == 280
    data = yaml.safe_load(store.render(d))
    assert "w" not in data["widgets"][0] and data["widgets"][0]["width"] == 25.0
    assert store.parse("title: x\nwidgets: [{id: a, w: 30, h: 9}]").widgets[0].width == 100.0


@pytest.mark.parametrize(("text", "fragment"), [
    ("title: x\nwidgets: [{id: a, width: 101}]", "widgets.0.width"),
    ("title: x\nwidgets: [{id: a, height: 10}]", "widgets.0.height"),
    ("title: x\ncanvas_width: 100", "canvas_width"),
    ("title: x\nwidgets: [{id: a, type: pie}]", "widgets.0.type"),
    ("title: x\nwidgets: [{id: A b}]", "widgets.0.id"),
    ("title: x\nwidgets: [{id: a}, {id: a}]", "unique"),
    ("title: x\nperiod: {current: {start: '2026-02-01', end: '2026-01-01'}}", "start must be on or before"),
    ("title: x\nperiod: {compare: last_week}", "period.compare"),
    ("title: x\nversion: 2", "version"),
    ("- a list", "mapping"),
    ("title: [unclosed", "YAML"),
])
def test_validation_errors_name_the_field(text: str, fragment: str) -> None:
    with pytest.raises(DashboardError) as err:
        store.parse(text)
    assert fragment in err.value.message


@pytest.mark.parametrize("slug", ["../x", "a/b", "A", "", ".hidden", "x" * 81, "a b"])
def test_slug_safety(slug: str, tmp_path: Path) -> None:
    with pytest.raises(DashboardError):
        store.file_for(tmp_path, None, slug)


def test_dashboards_dir_must_stay_inside_project(tmp_path: Path) -> None:
    assert store.dashboards_dir(tmp_path, None) == (tmp_path / "wickd" / "dashboards").resolve()
    assert store.dashboards_dir(tmp_path, " boards ") == (tmp_path / "boards").resolve()
    with pytest.raises(DashboardError):
        store.dashboards_dir(tmp_path, "../elsewhere")


def test_list_write_read_delete(tmp_path: Path) -> None:
    folder = tmp_path / "wickd" / "dashboards"
    assert store.list_dashboards(tmp_path, None) == []
    store.write(tmp_path, None, "rev", store.parse(SAMPLE), create=True)
    folder.joinpath("broken.yml").write_text("title: [")
    folder.joinpath("notes.txt").write_text("ignored")
    entries = store.list_dashboards(tmp_path, None)
    assert [(e.slug, e.error is None) for e in entries] == [("broken", False), ("rev", True)]
    assert entries[1].path == "wickd/dashboards/rev.yml"
    with pytest.raises(DashboardError, match="already exists"):
        store.write(tmp_path, None, "rev", store.parse(SAMPLE), create=True)
    assert store.unique_slug(tmp_path, None, "Rev") == "rev-2"
    assert store.read(tmp_path, None, "rev").dashboard.title == "Revenue overview"
    store.delete(tmp_path, None, "rev")
    with pytest.raises(DashboardError, match="no dashboard"):
        store.read(tmp_path, None, "rev")
    assert not list(folder.glob(".*"))


def test_slugify() -> None:
    assert store.slugify("Revenue — Overview 2026!") == "revenue-overview-2026"
    assert store.slugify("!!!") == "dashboard"


# ── periods ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(("preset", "start", "end"), [
    ("last_7_days", "2026-10-22", "2026-10-28"),
    ("last_30_days", "2026-09-29", "2026-10-28"),
    ("last_12_months", "2025-10-29", "2026-10-28"),
    ("month_to_date", "2026-10-01", "2026-10-28"),
    ("quarter_to_date", "2026-10-01", "2026-10-28"),
    ("year_to_date", "2026-01-01", "2026-10-28"),
    ("last_month", "2026-09-01", "2026-09-30"),
    ("last_quarter", "2026-07-01", "2026-09-30"),
])
def test_current_presets(preset: str, start: str, end: str) -> None:
    assert resolve_current(preset, TODAY).to_dict() == {"start": start, "end": end}


def test_all_time_has_no_dates_or_comparison() -> None:
    assert resolve_current("all_time", TODAY) is None
    assert resolve_compare("previous_period", None) is None


def test_comparisons() -> None:
    current = resolve_current("last_month", TODAY)
    assert resolve_compare("previous_period", current).to_dict() == {"start": "2026-08-02", "end": "2026-08-31"}
    assert resolve_compare("previous_year", current).to_dict() == {"start": "2025-09-01", "end": "2025-09-30"}
    assert resolve_compare("none", current) is None
    custom = DateRange(start="2026-01-01", end="2026-01-31")
    assert resolve_compare(custom, current).to_dict() == {"start": "2026-01-01", "end": "2026-01-31"}
    leap = Range(date(2028, 2, 29), date(2028, 2, 29))
    assert resolve_compare("previous_year", leap).to_dict() == {"start": "2027-02-28", "end": "2027-02-28"}


def test_auto_grain() -> None:
    assert auto_grain(resolve_current("last_30_days", TODAY)) == "day"
    assert auto_grain(resolve_current("last_90_days", TODAY)) == "week"
    assert auto_grain(resolve_current("last_12_months", TODAY)) == "month"
    assert auto_grain(Range(date(2020, 1, 1), TODAY)) == "quarter"
    assert auto_grain(None) == "month"


# ── widget planning ──────────────────────────────────────────────────────────


def _roles(plan) -> dict[str, dict]:
    return {q.role: q.query for q in plan.queries}


def test_summary_total_and_trend_with_comparison() -> None:
    plan = _plan({"type": "summary", "metrics": ["revenue"]}, filters=[REGION])
    q = _roles(plan)
    assert list(q) == ["total", "total_previous", "trend", "trend_previous"]
    assert q["total"] == {"metrics": ["revenue"], "where": [REGION], "start": "2026-09-29", "end": "2026-10-28"}
    assert q["total_previous"]["start"] == "2026-08-30" and q["total_previous"]["end"] == "2026-09-28"
    assert q["trend"]["group_by"] == ["metric_time__day"]
    assert plan.grain == "day" and plan.current.to_dict()["start"] == "2026-09-29"


def test_summary_without_trend_or_comparison() -> None:
    plan = _plan({"type": "summary", "metrics": ["revenue"], "options": {"trend": False}},
                 period={"compare": "none"})
    assert list(_roles(plan)) == ["total"] and plan.previous is None


def test_summary_parts_drop_their_previous_queries() -> None:
    no_line = _plan({"type": "summary", "metrics": ["revenue"], "options": {"previous_line": False}})
    assert list(_roles(no_line)) == ["total", "total_previous", "trend"]
    totals_only = _plan({"type": "summary", "metrics": ["revenue"],
                         "options": {"show_change": False, "show_previous": False}})
    assert list(_roles(totals_only)) == ["total", "trend", "trend_previous"]
    change_only = _plan({"type": "summary", "metrics": ["revenue"], "options": {"show_previous": False, "trend": False}})
    assert list(_roles(change_only)) == ["total", "total_previous"]


def test_widget_period_override_per_key() -> None:
    plan = _plan({"type": "timeseries", "metrics": ["revenue"], "period": {"current": "last_7_days"}},
                 period={"current": "last_90_days", "compare": "previous_year"})
    assert plan.current.to_dict() == {"start": "2026-10-22", "end": "2026-10-28"}
    assert plan.previous.to_dict() == {"start": "2025-10-22", "end": "2025-10-28"}
    assert plan.grain == "day"  # auto follows the widget's current period


def test_timeseries_grain_and_split() -> None:
    plan = _plan({"type": "timeseries", "metrics": ["revenue"], "options": {"grain": "month", "split_by": "order__channel"}},
                 grain="week")
    assert _roles(plan)["current"]["group_by"] == ["metric_time__month", "order__channel"]
    assert plan.grain == "month"


def test_bar_top_n_and_previous_without_limit() -> None:
    q = _roles(_plan({"type": "bar", "metrics": ["revenue"], "options": {"dimension": "customer__region", "top_n": 5}}))
    assert q["current"]["group_by"] == ["customer__region"] and q["current"]["limit"] == 5
    assert q["current"]["order_by"] == ["-revenue"]
    assert "limit" not in q["current_previous"]


def test_stacked_bar_is_compared_by_bar_and_stack() -> None:
    plan = _plan({"type": "bar", "metrics": ["revenue"],
                  "options": {"dimension": "customer__region", "stack_by": "order__channel"}})
    q = _roles(plan)
    assert list(q) == ["current", "current_previous"] and plan.notes == ()
    assert q["current_previous"]["group_by"] == ["customer__region", "order__channel"]
    assert "limit" not in q["current"]  # top N bars are picked from the totals client side


def test_bar_previous_period_can_be_hidden() -> None:
    for options in ({}, {"stack_by": "order__channel"}):
        plan = _plan({"type": "bar", "metrics": ["revenue"],
                      "options": {"dimension": "customer__region", "show_previous": False, **options}})
        assert list(_roles(plan)) == ["current"]


def test_table_and_leaderboard() -> None:
    t = _roles(_plan({"type": "table", "metrics": ["revenue", "order_count"],
                      "options": {"dimensions": ["customer__region"], "compare_columns": False, "limit": 20}}))
    assert list(t) == ["current"] and t["current"]["limit"] == 20
    lb = _roles(_plan({"type": "leaderboard", "metrics": ["revenue", "order_count"], "options": {"dimension": "customer__region"}}))
    assert lb["current"]["metrics"] == ["revenue"] and lb["current"]["limit"] == 10
    assert "current_previous" in lb


def test_table_rows_by_period() -> None:
    plan = _plan({"type": "table", "metrics": ["revenue"], "options": {"period_grain": "auto"}})
    t = _roles(plan)
    assert t["current"]["group_by"] == ["metric_time__day"] and t["current"]["order_by"] == ["metric_time__day"]
    assert t["current"]["limit"] == 50 and "limit" not in t["current_previous"]
    weekly = _plan({"type": "table", "metrics": ["revenue"],
                    "options": {"period_grain": "week", "dimensions": ["customer__region"]}})
    w = _roles(weekly)
    assert w["current"]["group_by"] == ["metric_time__week", "customer__region"]
    assert w["current"]["order_by"] == ["metric_time__week", "-revenue"] and weekly.grain == "week"


def test_text_and_empty_widgets_have_no_queries() -> None:
    assert _plan({"type": "text", "options": {"body": "# Hi"}}).queries == ()
    empty = _plan({"type": "timeseries"})
    assert empty.queries == () and empty.empty


def test_filters_skipped_where_a_metric_lacks_the_dimension() -> None:
    plan = _plan({"type": "summary", "metrics": ["revenue", "order_count"], "filters": ["x = 1"],
                  "options": {"trend": False}}, filters=[STATUS, REGION], period={"compare": "none"})
    assert _roles(plan)["total"]["where"] == [REGION, "x = 1"]
    assert plan.notes == ("dashboard filter on `order__status` doesn't apply to this widget",)


@pytest.mark.parametrize(("widget", "message"), [
    ({"type": "summary", "metrics": ["gone", "revenue"]}, "metric `gone` no longer exists"),
    ({"type": "bar", "metrics": ["revenue"]}, "pick a dimension"),
    ({"type": "leaderboard", "metrics": ["revenue"]}, "pick a dimension to rank"),
    ({"type": "bar", "metrics": ["revenue", "order_count"], "options": {"dimension": "order__channel"}}, "isn't a dimension"),
    ({"type": "timeseries", "metrics": ["revenue"], "options": {"style": "pie"}}, "invalid options: style"),
])
def test_broken_widgets(widget: dict, message: str) -> None:
    with pytest.raises(WidgetBroken, match=message):
        _plan(widget)


def test_all_time() -> None:
    plan = _plan({"type": "summary", "metrics": ["revenue"]}, period={"current": "all_time"})
    assert "start" not in _roles(plan)["total"] and plan.previous is None and plan.grain == "month"


def test_names() -> None:
    assert referenced_names("{{ TimeDimension('metric_time', 'day') }} > '1' and {{ Entity('customer') }} = 1") == {
        "metric_time", "customer"}
    assert "customer" in shared_names(CATALOG, ["revenue"])
    assert shared_names(CATALOG, ["revenue", "order_count"]) == {"customer__region", "customer", "order", "metric_time"}
    assert shared_names(CATALOG, ["missing"]) == set()


def test_plan_11_files_are_upgraded_on_read() -> None:
    legacy = """\
version: 1
title: Executive Overview
filters:
  date_range: last_90_days
  where: ["{{ Dimension('customer__region') }} = 'north'"]
tiles:
- {id: orders_count, viz: kpi, w: 3, h: 1, query: {metrics: [orders_count], start: '2026-07-31'}, compare: previous_period}
- {id: weekly, viz: area, query: {metrics: [revenue], group_by: [metric_time__week, order__channel]}}
- {id: stack, viz: stacked_bar, query: {metrics: [revenue], group_by: [customer__region, order__channel], where: [x]}}
- {id: tbl, viz: table, query: {metrics: [revenue], group_by: [customer__region], start: '2026-01-01', end: '2026-01-31'}}
- {id: sq, viz: line, saved_query: weekly_revenue}
"""
    d = store.parse(legacy)
    assert d.period.current == "last_90_days" and d.filters == [REGION]
    data = {w.id: w.model_dump(exclude_none=True) for w in d.widgets}
    assert data["orders_count"] == {"id": "orders_count", "type": "summary", "width": 25.0, "height": 132,
                                    "metrics": ["orders_count"], "filters": [], "options": {}}
    assert data["weekly"]["type"] == "timeseries"
    assert data["weekly"]["options"] == {"grain": "week", "split_by": "order__channel", "style": "area"}
    assert data["stack"]["options"] == {"dimension": "customer__region", "stack_by": "order__channel"}
    assert data["stack"]["filters"] == ["x"]
    assert data["tbl"]["period"]["current"] == {"start": "2026-01-01", "end": "2026-01-31"}
    assert data["sq"]["metrics"] == [] and "weekly_revenue" in data["sq"]["title"]
    assert "tiles" not in yaml.safe_load(store.render(d))
