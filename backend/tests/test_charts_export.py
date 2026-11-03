"""Export a wickd dashboard as dbt Charts board YAML (pure; one dct integration check when it's installed)."""

import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

from app.charts import export, sidecar_env
from app.semantic.dashboard_plan import options_for
from app.semantic.dashboards import Dashboard, Widget

REL = '"dev"."main_gold"."mart_sales"'
SQL = f"""-- Read Elements From Semantic Model 'orders'
-- Metric Time Dimension 'order_date'
SELECT
  DATE_TRUNC('day', order_date) AS metric_time__day
  -- Select: inner comment
  , SUM(net) AS revenue
FROM {REL} orders_src_1
GROUP BY 1"""


def _w(widget_id: str, type_: str, metrics: list[str], width: float = 50, **options: object) -> Widget:
    return Widget(id=widget_id, type=type_, metrics=metrics, width=width, options=dict(options))


def _ew(w: Widget, group_by: tuple[str, ...] = (), **kw: object) -> export.ExportWidget:
    return export.ExportWidget(w, options_for(w), sql=SQL, group_by=group_by, **kw)


def _board(widgets: list[export.ExportWidget], **dash: object) -> tuple[dict, export.ExportResult]:
    dashboard = Dashboard(title="Sales", widgets=[e.widget for e in widgets], **dash)
    result = export.build_board(dashboard, widgets, {REL: "mart_sales"}, "2026-10-01 – 2026-10-31")
    return yaml.safe_load(result.text), result


def test_clean_sql_drops_comments_and_refs_relations() -> None:
    out = export.clean_sql(SQL, {REL: "mart_sales"})
    assert "--" not in out
    assert "FROM {{ ref('mart_sales') }} orders_src_1" in out
    assert out.startswith("SELECT")


def test_relation_map_only_own_unversioned_nodes() -> None:
    manifest = {"metadata": {"project_name": "shop"}, "nodes": {
        "model.shop.a": {"resource_type": "model", "package_name": "shop", "name": "a", "relation_name": '"d"."s"."a"'},
        "model.pkg.b": {"resource_type": "model", "package_name": "pkg", "name": "b", "relation_name": '"d"."s"."b"'},
        "test.shop.t": {"resource_type": "test", "package_name": "shop", "name": "t", "relation_name": '"d"."s"."t"'},
        "model.shop.v": {"resource_type": "model", "package_name": "shop", "name": "v", "relation_name": '"d"."s"."v"', "version": 2},
    }}
    assert export.relation_map(manifest) == {'"d"."s"."a"': "a"}


def test_summary_becomes_one_kpi_per_metric() -> None:
    board, result = _board([_ew(_w("totals", "summary", ["revenue", "orders"], 100, format="currency"))])
    assert set(board["charts"]) == {"totals_revenue", "totals_orders"}
    assert board["charts"]["totals_revenue"] == {
        "type": "kpi", "query": "totals", "value": "revenue", "label": "Revenue", "style": {"value": {"format": "currency_compact"}},
    }
    assert board["rows"] == [{"cols": [{"width": "100%", "cols": ["totals_revenue", "totals_orders"]}]}]
    assert result.chart_count == 2


def test_timeseries_split_fills_null_series() -> None:
    w = _w("trend", "timeseries", ["revenue"], 100, split_by="order__channel", style="stacked")
    board, _ = _board([_ew(w, group_by=("metric_time__week", "order__channel"))])
    chart = board["charts"]["trend"]
    assert chart["type"] == "area" and chart["x"] == "metric_time__week"
    assert chart["color"] == "order__channel" and chart["style"] == {"stack": "zero"}
    sql = board["queries"]["trend"]
    assert sql.startswith("SELECT COALESCE(order__channel, 'Unknown') AS order__channel, metric_time__week, revenue")
    assert "{{ ref('mart_sales') }}" in sql


def test_timeseries_several_metrics_without_split() -> None:
    board, _ = _board([_ew(_w("t", "timeseries", ["revenue", "orders"], 100), group_by=("metric_time__day",))])
    assert board["charts"]["t"]["y"] == ["revenue", "orders"]
    assert board["charts"]["t"]["type"] == "line"


def test_bar_leaderboard_table() -> None:
    board, _ = _board([
        _ew(_w("by-cat", "bar", ["revenue"], 50, dimension="order__category", orientation="horizontal")),
        _ew(_w("top", "leaderboard", ["revenue"], 50, dimension="customer__name")),
        _ew(_w("detail", "table", ["revenue"], 100, dimensions=["order__category"])),
    ])
    bar = board["charts"]["by_cat"]
    assert bar["type"] == "bar" and bar["x"] == "order__category" and bar["style"] == {"orientation": "horizontal"}
    assert bar["sort"] == {"by": "revenue", "order": "desc"}
    assert board["charts"]["top"]["style"] == {"orientation": "horizontal"}
    assert board["charts"]["detail"] == {"title": "Revenue", "query": "detail", "type": "table"}
    assert board["rows"][0] == {"cols": [{"width": "50%", "rows": ["by_cat"]}, {"width": "50%", "rows": ["top"]}]}
    assert board["rows"][1] == "detail"


def test_text_rows_failed_widgets_and_notes() -> None:
    text = Widget(id="note", type="text", width=100, options={"body": "## Read me"})
    failed = export.ExportWidget(_w("bad", "summary", ["gone"]), options_for(_w("bad", "summary", ["gone"])), error="metric gone")
    board, result = _board([
        export.ExportWidget(text, options_for(text)),
        _ew(_w("totals", "summary", ["revenue"], 100), has_comparison=True),
        failed,
    ], filters=["{{ Dimension('order__channel') }} = 'web'"])
    assert board["rows"][0] == {"text": "## Read me"}
    assert "bad" not in board["charts"]
    notes = " | ".join(result.notes)
    assert "bad: left out (metric gone)" in notes
    assert "previous-period comparisons aren't exported (totals)" in notes
    assert "dashboard filters" in notes
    assert "2026-10-01 – 2026-10-31" in board["text"]


def test_widths_wrap_into_rows() -> None:
    widgets = [_ew(_w(f"w{i}", "summary", ["revenue"], 40)) for i in range(3)]
    board, _ = _board(widgets)
    assert len(board["rows"]) == 2
    assert board["rows"][1] == "w2"


def _dct() -> Path | None:
    path = os.environ.get("WICKD_TEST_DCT")
    if path:
        return Path(path)
    return sidecar_env.dct_path() if sidecar_env.dct_path().exists() else None


@pytest.mark.skipif(_dct() is None, reason="dct isn't installed (set WICKD_TEST_DCT or build the sidecar)")
def test_dct_validate_accepts_the_export(tmp_path: Path) -> None:
    (tmp_path / "dbt_project.yml").write_text("name: shop\nprofile: shop\n")
    (tmp_path / "charts").mkdir()
    _board_data, result = _board([
        _ew(_w("totals", "summary", ["revenue", "orders"], 50)),
        _ew(_w("trend", "timeseries", ["revenue"], 50, split_by="order__channel"), group_by=("metric_time__day", "order__channel")),
        _ew(_w("by-cat", "bar", ["revenue"], 50, dimension="order__category", stack_by="order__channel")),
        _ew(_w("detail", "table", ["revenue"], 50, dimensions=["order__category"])),
    ])
    (tmp_path / "charts" / "sales.yml").write_text(result.text)
    out = subprocess.run(
        [str(_dct()), "--no-send-anonymous-usage-stats", "--no-workspace-guard", "validate", "charts/sales.yml", "--json"],
        cwd=tmp_path, capture_output=True, text=True, timeout=120, check=False,
    )
    data = json.loads(out.stdout)
    assert data["errors"] == [], data["errors"]
