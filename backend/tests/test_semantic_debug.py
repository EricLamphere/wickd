"""Metric debugging (plan 15): check builders, interpretation, SQL steps and reconcile (pure),
plus the check SQL run on a real DuckDB with a planted fan-out (skipped without the dbt venv)."""

import json
import subprocess
from pathlib import Path

import pytest

from app.semantic.debug_checks import interpret, warnings
from app.semantic.debug_queries import build_checks, iso_or_none, resolve_filter, string_type
from app.semantic.debug_reconcile import ReconcileError, reconcile
from app.semantic.debug_sql import attach_steps, sql_steps
from app.semantic.query_spec import checked_sql

ORDERS = {
    "relation": '"bench"."main"."stg_orders"',
    "entities": [{"name": "order_id", "type": "primary", "expr": "order_id"},
                 {"name": "customer", "type": "foreign", "expr": "customer_id"}],
    "dimensions": [{"name": "order_date", "type": "time", "expr": "order_date"},
                   {"name": "status", "type": "categorical", "expr": "status"}],
}
CUSTOMERS = {
    "relation": '"bench"."main"."dim_customers"',
    "entities": [{"name": "customer", "type": "primary", "expr": "customer_id"}],
    "dimensions": [{"name": "region", "type": "categorical", "expr": "region"},
                   {"name": "signup_date", "type": "time", "expr": "signup_date"}],
}
EXPLAINED = {
    "sql": "select 1",
    "plan": [
        {"id": "rss_1", "kind": "read", "label": "Read From SemanticModelDataSet('orders')", "inputs": [],
         "semantic_model": "orders"},
        {"id": "rss_2", "kind": "read", "label": "Read From SemanticModelDataSet('customers')", "inputs": [],
         "semantic_model": "customers"},
        {"id": "jso_0", "kind": "join", "label": "Join Standard Outputs", "inputs": ["rss_1", "rss_2"],
         "left_models": ["orders"],
         "targets": [{"entity": "customer", "join_type": "left_outer", "semantic_models": ["customers"]}]},
        {"id": "am_0", "kind": "aggregate", "label": "Aggregate Inputs for Simple Metrics", "inputs": ["jso_0"]},
    ],
    "inputs": [{"metric": "completed_revenue", "via": "completed_revenue", "semantic_model": "orders",
                "expr": "amount", "agg": "sum", "agg_time_dimension": "order_date",
                "filters": ["{{ Dimension('order_id__status') }} = 'completed'"]}],
    "group_by": [
        {"name": "customer__region", "kind": "dimension", "element": "region", "entity_links": ["customer"],
         "semantic_model": "customers", "expr": "region"},
        {"name": "metric_time__month", "kind": "metric_time", "element": "metric_time", "entity_links": []},
    ],
    "models": {"orders": ORDERS, "customers": CUSTOMERS},
}
QUERY = {"metrics": ["completed_revenue"], "group_by": ["metric_time__month", "customer__region"],
         "start": "2026-01-01", "end": "2026-03-31"}


# ── builders ─────────────────────────────────────────────────────────────────

def test_resolve_filter_on_the_inputs_own_model() -> None:
    assert resolve_filter("{{ Dimension('order_id__status') }} = 'completed'", ORDERS) == "(status) = 'completed'"
    assert resolve_filter('{{ Entity("customer") }} is not null', ORDERS) == "(customer_id) is not null"
    assert resolve_filter("{{ TimeDimension('order_id__order_date', 'day') }} > '2026-01-01'", ORDERS) is not None


def test_resolve_filter_refuses_joined_dimensions_and_grains() -> None:
    assert resolve_filter("{{ Dimension('customer__region') }} = 'EU'", ORDERS) is None
    assert resolve_filter("{{ TimeDimension('order_id__order_date', 'month') }} = '2026-01-01'", ORDERS) is None
    assert resolve_filter("{{ Metric('revenue', group_by=['customer']) }} > 1", ORDERS) is None


def test_iso_literals_only() -> None:
    assert iso_or_none("2026-01-01") == "2026-01-01"
    assert iso_or_none("2026-01-01 10:00:00") == "2026-01-01 10:00:00"
    assert iso_or_none("2026-01-01'; drop table x; --") is None
    assert iso_or_none(None) is None


def test_build_checks_covers_inputs_joins_and_dimensions() -> None:
    checks, notes = build_checks(EXPLAINED, QUERY, "duckdb")
    assert [c.kind for c in checks] == ["input", "join", "dimension", "variants"]
    by_kind = {c.kind: c for c in checks}
    assert by_kind["input"].node == "rss_1"
    assert by_kind["input"].meta["items"][0]["filter_checked"] is True
    assert "(status) = 'completed'" in by_kind["input"].sql
    assert "cast('2026-01-01' as timestamp)" in by_kind["input"].sql
    assert by_kind["join"].node == "jso_0"
    assert by_kind["join"].meta | {"dimensions": ["customer__region"]} == by_kind["join"].meta
    assert by_kind["dimension"].node == "rss_2"
    assert notes == []


def test_inputs_on_one_table_share_one_query_and_one_coverage_check() -> None:
    second = {**EXPLAINED["inputs"][0], "metric": "orders_count", "expr": "1", "agg": "count", "filters": []}
    explained = {**EXPLAINED, "inputs": [EXPLAINED["inputs"][0], second]}
    checks, _ = build_checks(explained, QUERY, "duckdb")
    [inputs] = [c for c in checks if c.kind == "input"]
    assert [i["metric"] for i in inputs.meta["items"]] == ["completed_revenue", "orders_count"]
    assert "kept_rows_1" in inputs.sql and "null_rows_1" in inputs.sql
    found = interpret(inputs, [[100, 40, "2026-01-01", "2026-03-31", 30, 0, 40, 0]], None)
    assert [f["id"] for f in found] == ["input:0:rows", "input:0:time", "input:0:filter:0", "input:0:nulls:0",
                                        "input:0:nulls:1"]
    assert found[0]["detail"] == "`completed_revenue`, `orders_count` read orders: 100 rows (40 in range)."
    assert len(warnings(found)) == 0


def test_query_filters_on_joined_models_are_noted() -> None:
    query = {**QUERY, "where": ["{{ Dimension('customer__region') }} = 'EU'"]}
    _, notes = build_checks(EXPLAINED, query, "duckdb")
    assert notes == ["The query's filters that need a join aren't applied to orders's row counts."]


@pytest.mark.parametrize("adapter", ["duckdb", "snowflake", "bigquery", "postgres", "databricks", "redshift"])
def test_every_check_is_one_read_only_select(adapter: str) -> None:
    checks, _ = build_checks(EXPLAINED, QUERY, adapter)
    for check in checks:
        assert checked_sql(check.sql, adapter)
    assert string_type(adapter) == ("string" if adapter in ("bigquery", "databricks") else "varchar")


def test_unresolvable_join_is_noted_not_checked() -> None:
    explained = {**EXPLAINED, "models": {"orders": ORDERS}}
    checks, notes = build_checks(explained, QUERY, "duckdb")
    assert "join" not in [c.kind for c in checks]
    assert notes == ["The join on `customer` wasn't checked: its models couldn't be resolved."]


# ── interpretation ───────────────────────────────────────────────────────────

def _checks() -> dict:
    checks, _ = build_checks(EXPLAINED, QUERY, "duckdb")
    return {c.kind: c for c in checks}


def test_input_findings() -> None:
    found = interpret(_checks()["input"], [[100, 40, "2025-11-01", "2026-02-15", 30, 3]], None)
    by = {f["check"]: f for f in found}
    assert by["rows"]["status"] == "ok" and by["rows"]["value"] == "100"
    assert by["filter"]["status"] == "info" and by["filter"]["value"] == "keeps 75.0%"
    assert by["nulls"]["status"] == "warn" and "3 of 30" in by["nulls"]["detail"]
    assert by["time"]["status"] == "warn"  # data stops 2026-02-15, range ends 2026-03-31


def test_input_with_no_rows_in_range_and_no_overlap() -> None:
    found = interpret(_checks()["input"], [[100, 0, "2020-01-01", "2020-06-30", 0, 0]], None)
    statuses = {f["check"]: f["status"] for f in found}
    assert statuses == {"rows": "warn", "filter": "info", "time": "fail"}


def test_join_fanout_is_a_failure() -> None:
    [fanout] = [f for f in interpret(_checks()["join"], [[10, 18, 0, 0, 4]], None) if f["id"].endswith("fanout")]
    assert fanout["status"] == "fail"
    assert fanout["value"] == "1.80× rows"
    assert "4 `customer` values repeat in customers" in fanout["detail"]


def test_join_unmatched_rows_point_at_the_dimension() -> None:
    found = interpret(_checks()["join"], [[100, 100, 3, 1, 0]], None)
    assert [f["status"] for f in found] == ["ok", "warn"]
    assert "they show under ∅ for `customer__region`" in found[1]["detail"]
    assert "(1 have no `customer` at all)" in found[1]["detail"]


def test_dimension_and_variant_findings() -> None:
    checks = _checks()
    [nulls] = interpret(checks["dimension"], [[50, 2, 1, 5, 4]], None)
    assert nulls["status"] == "warn" and nulls["value"] == "6.0%"
    [variants] = interpret(checks["variants"], [["us", 2, "US", "us ", 9]], None)
    assert variants["status"] == "warn" and "'US' / 'us '" in variants["detail"]
    assert interpret(checks["variants"], [], None)[0]["status"] == "ok"


def test_failed_check_and_warning_order() -> None:
    checks = _checks()
    [err] = interpret(checks["join"], None, "Catalog Error: table not found")
    assert err["status"] == "error"
    found = interpret(checks["join"], [[10, 18, 1, 0, 4]], None) + [err]
    assert [f["status"] for f in warnings(found)] == ["fail", "error", "warn"]


# ── SQL steps ────────────────────────────────────────────────────────────────

MF_SQL = """-- Constrain Output with WHERE
-- Aggregate Inputs for Simple Metrics
SELECT
  metric_time__month
  , SUM(completed_revenue) AS completed_revenue
FROM (
  -- Join Standard Outputs
  SELECT
    DATE_TRUNC('month', o.order_date) AS metric_time__month
    , o.amount AS completed_revenue
  FROM "bench"."main"."stg_orders" o
  LEFT OUTER JOIN "bench"."main"."dim_customers" c ON o.customer_id = c.customer_id
) subq_5
WHERE order_id__status = 'completed'
GROUP BY metric_time__month"""


def test_sql_steps_innermost_first_and_runnable() -> None:
    steps = sql_steps(MF_SQL)
    assert [s["labels"] for s in steps] == [["Join Standard Outputs"],
                                            ["Constrain Output with WHERE", "Aggregate Inputs for Simple Metrics"]]
    assert steps[0]["sql"].rstrip().endswith("c.customer_id")
    assert checked_sql(steps[0]["sql"], "duckdb")
    assert steps[1]["sql"].endswith("GROUP BY metric_time__month")


def test_attach_steps_by_description() -> None:
    plan = attach_steps(EXPLAINED["plan"], sql_steps(MF_SQL))
    assert {n["id"]: n["step"] for n in plan} == {"rss_1": None, "rss_2": None, "jso_0": 0, "am_0": 1}


# ── reconcile ────────────────────────────────────────────────────────────────

def test_reconcile_aligns_by_key_case_insensitively() -> None:
    ours = {"columns": ["metric_time__month", "revenue"],
            "rows": [["2026-01-01", 10.0], ["2026-02-01", 20.0], ["2026-03-01", 5.0]]}
    theirs = {"columns": ["METRIC_TIME__MONTH", "REVENUE"],
              "rows": [["2026-01-01 00:00:00", 10], ["2026-02-01 00:00:00", 25], ["2026-04-01 00:00:00", 1]]}
    out = reconcile(ours, theirs, ["metric_time__month"], ["revenue"])
    assert out["summary"] == {"keys": 4, "matching": 1, "different": 1, "only_metric": 1, "only_sql": 1}
    assert out["columns"] == ["metric_time__month", "status", "revenue (metric)", "revenue (sql)", "revenue difference"]
    assert ["2026-02-01", "different", 20.0, 25, -5.0] in out["rows"]


def test_reconcile_needs_the_key_and_metric_columns() -> None:
    ours = {"columns": ["region", "revenue"], "rows": []}
    with pytest.raises(ReconcileError, match="`region`"):
        reconcile(ours, {"columns": ["revenue"], "rows": []}, ["region"], ["revenue"])
    with pytest.raises(ReconcileError, match="named like the metric"):
        reconcile(ours, {"columns": ["region", "total"], "rows": []}, ["region"], ["revenue"])


# ── the check SQL on a real warehouse (DuckDB) ───────────────────────────────

DBT_PYTHON = Path(__file__).parents[2] / "data" / "dbt-venv" / "bin" / "python"
_RUN_DUCKDB = """
import duckdb, json, sys
con = duckdb.connect()
con.execute("attach ':memory:' as bench")
con.execute("create table bench.main.stg_orders as select * from (values "
            "(1, 10, 100.0, date '2026-01-05', 'completed'), (2, 10, 50.0, date '2026-01-20', 'completed'),"
            "(3, 11, null, date '2026-02-02', 'completed'), (4, 12, 30.0, date '2026-02-10', 'returned'),"
            "(5, 99, 20.0, date '2026-02-11', 'completed')) t(order_id, customer_id, amount, order_date, status)")
con.execute("create table bench.main.dim_customers as select * from (values "
            "(10, 'US'), (10, 'us '), (11, null), (12, 'EU')) t(customer_id, region)")
out = {}
for cid, sql in json.loads(sys.stdin.read()).items():
    out[cid] = [list(r) for r in con.execute(sql).fetchall()]
print(json.dumps(out, default=str))
"""


@pytest.mark.skipif(not DBT_PYTHON.exists(), reason="dbt venv (with duckdb) not built")
def test_checks_find_a_planted_fanout_on_duckdb() -> None:
    checks, _ = build_checks(EXPLAINED, QUERY, "duckdb")
    sqls = {c.id: checked_sql(c.sql, "duckdb") for c in checks}
    done = subprocess.run([str(DBT_PYTHON), "-I", "-c", _RUN_DUCKDB], input=json.dumps(sqls), capture_output=True,
                          text=True, timeout=60, check=True)
    rows = json.loads(done.stdout)
    findings = [f for c in checks for f in interpret(c, rows[c.id], None)]
    by_id = {f["id"]: f for f in findings}
    assert by_id["join:0:fanout"]["status"] == "fail"  # customer 10 appears twice in dim_customers
    assert by_id["join:0:fanout"]["value"] == "1.40× rows"  # 5 orders → 7 rows
    assert by_id["join:0:coverage"]["status"] == "warn"  # customer 99 has no row
    assert by_id["input:0:nulls:0"]["status"] == "warn"  # order 3's amount is null
    assert by_id["input:0:filter:0"]["value"] == "keeps 80.0%"
    assert by_id["dimension:customer__region:nulls"]["status"] == "warn"
    assert by_id["variants:customer__region:variants"]["status"] == "warn"
