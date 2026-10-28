"""Metric monitors' pure helpers: history windows, slice filters, row parsing, the post-run
ancestor check, and the health summary."""

from datetime import UTC, date, datetime

import pytest

from app.health.summary import summarize_metric_monitors
from app.semantic import monitor_queries as mq
from app.semantic.monitors import parse_interval
from app.semantic.query_spec import check_where


def test_window_start_first_run_then_trailing() -> None:
    today = date(2026, 10, 28)  # a Wednesday
    assert mq.window_start(today, "day", 180, has_history=False) == date(2026, 5, 1)
    assert mq.window_start(today, "day", 180, has_history=True) == date(2026, 9, 23)
    assert mq.window_start(today, "week", 52, has_history=False) == date(2025, 10, 27)
    assert mq.window_start(today, "month", 24, has_history=True) == date(2025, 8, 1)
    # a lookback shorter than the trailing window wins
    assert mq.window_start(today, "day", 10, has_history=True) == date(2026, 10, 18)


def test_period_ended() -> None:
    assert not mq.period_ended("2026-10-27", "day", datetime(2026, 10, 27, 23, tzinfo=UTC))
    assert mq.period_ended("2026-10-27", "day", datetime(2026, 10, 28, 0, 5, tzinfo=UTC))
    assert not mq.period_ended("2026-10-01", "month", datetime(2026, 10, 31, tzinfo=UTC))
    assert mq.period_ended("2026-10-26", "week", datetime(2026, 11, 2, tzinfo=UTC))


def test_slice_filter_is_a_valid_metricflow_filter() -> None:
    where = mq.slice_filter("customer__region", ["north", "o'brien", 3, 2.5])
    assert where == "{{ Dimension('customer__region') }} in ('north', 'o''brien', 3, 2.5)"
    check_where(where, "duckdb")


def test_unsafe_slices_are_dropped() -> None:
    assert mq.filterable_slices(["ok", "a;b", "x--y", "{{ x }}", None, True, 7]) == ["ok", 7]


def test_series_query_shapes() -> None:
    start = date(2026, 1, 1)
    assert mq.series_query("revenue", "week", None, [], start) == {
        "metrics": ["revenue"], "group_by": ["metric_time__week"], "start": "2026-01-01",
    }
    sliced = mq.series_query("revenue", "day", "customer__region", ["north"], start)
    assert sliced["group_by"] == ["metric_time__day", "customer__region"]
    assert sliced["where"] == ["{{ Dimension('customer__region') }} in ('north')"]
    assert mq.totals_query("revenue", "customer__region", start)["group_by"] == ["customer__region"]


def test_parse_series_case_insensitive_and_sliced() -> None:
    columns = ["METRIC_TIME__DAY", "CUSTOMER__REGION", "REVENUE"]
    rows = [
        ["2026-10-01 00:00:00", "north", 10],
        ["2026-10-01", "south", "12.5"],
        ["2026-10-02", None, None],
        [None, "north", 4],
    ]
    parsed = mq.parse_series(columns, rows, "revenue", "day", "customer__region")
    assert parsed == {
        "north": [("2026-10-01", 10.0)],
        "south": [("2026-10-01", 12.5)],
        "": [("2026-10-02", None)],
    }
    with pytest.raises(ValueError):
        mq.parse_series(["x", "revenue"], rows, "revenue", "day", None)


def test_parse_totals() -> None:
    totals = mq.parse_totals(["customer__region", "revenue"], [["north", 5], ["south", None]], "revenue",
                             "customer__region")
    assert totals == [{"slice": "north", "total": 5.0}, {"slice": "south", "total": None}]


def test_affected_monitors_walks_the_parent_map() -> None:
    parents = {
        "metric.p.revenue": ("semantic_model.p.orders",),
        "metric.p.ratio": ("metric.p.revenue", "metric.p.buyers"),
        "semantic_model.p.orders": ("model.p.stg_orders",),
        "model.p.stg_orders": ("seed.p.raw_orders",),
        "metric.p.buyers": ("semantic_model.p.customers",),
    }
    uids = {"revenue": "metric.p.revenue", "ratio": "metric.p.ratio", "buyers": "metric.p.buyers"}
    monitors = [(1, "revenue"), (2, "ratio"), (3, "buyers"), (4, "gone")]
    assert mq.affected_monitors(monitors, uids, parents, {"seed.p.raw_orders"}) == [1, 2]
    assert mq.affected_monitors(monitors, uids, parents, {"model.p.other"}) == []


@pytest.mark.parametrize(("raw", "hours"), [("6", 6), (" 12 ", 12), ("0", None), ("", None), ("x", None), (None, None)])
def test_parse_interval(raw: str | None, hours: int | None) -> None:
    assert parse_interval(raw) == hours


# ── health summary ───────────────────────────────────────────────────────────


def _monitor(status: str | None, *, metric: str = "revenue", target: str | None = "dev", pinned: str | None = None):
    latest = None if status is None else {
        "status": status, "metric": metric, "headline": f"{status} headline", "target": target,
        "checked_at": "2026-10-28T10:00:00+00:00",
    }
    return {"metric": metric, "target": pinned, "latest": latest}


def test_summary_not_run_and_running() -> None:
    assert summarize_metric_monitors([_monitor(None)], running=False, current_target="dev").status == "not_run"
    running = summarize_metric_monitors([_monitor("ok")], running=True, current_target="dev")
    assert running.status == "running" and running.headline == "Checking 1 monitor…"


def test_summary_statuses() -> None:
    ok = summarize_metric_monitors([_monitor("ok"), _monitor("ok")], running=False, current_target="dev")
    assert (ok.status, ok.headline, ok.issues) == ("ok", "All 2 monitors normal", 0)
    one = summarize_metric_monitors([_monitor("anomaly"), _monitor("ok")], running=False, current_target="dev")
    assert one.status == "fail" and one.headline == "revenue: anomaly headline"
    mixed = summarize_metric_monitors(
        [_monitor("anomaly"), _monitor("anomaly"), _monitor("error"), _monitor("warn"), _monitor(None)],
        running=False, current_target="dev",
    )
    assert mixed.status == "fail" and mixed.issues == 4
    assert mixed.headline == "2 anomalous · 1 failed to refresh · 1 warning"
    assert "1 monitor never checked" in mixed.stale_reasons
    warn = summarize_metric_monitors([_monitor("warn")], running=False, current_target="dev")
    assert warn.status == "warn"


def test_summary_flags_target_change_except_pinned() -> None:
    moved = summarize_metric_monitors([_monitor("ok", target="dev")], running=False, current_target="prod")
    assert moved.stale_reasons == ("Target changed to prod since this run",)
    pinned = summarize_metric_monitors([_monitor("ok", target="prod", pinned="prod")], running=False,
                                       current_target="dev")
    assert pinned.stale_reasons == ()
