"""worker_main's explain_plan op (plan 15) run by the real MetricFlow sidecar against the fixture
manifests in both YAML specs. Skipped when the sidecar venv hasn't been built
(WICKD_SIDECAR_PYTHON, else <repo>/data/metricflow-venv)."""

import json
import os
import subprocess
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"
WORKER = Path(__file__).parents[1] / "app" / "semantic" / "worker_main.py"
SIDECAR_PYTHON = Path(os.environ.get("WICKD_SIDECAR_PYTHON")
                      or Path(__file__).parents[2] / "data" / "metricflow-venv" / "bin" / "python")

pytestmark = pytest.mark.skipif(not SIDECAR_PYTHON.exists(), reason="MetricFlow sidecar venv not built")

SPECS = ["dbt_1_12", "dbt_1_12_latest"]


def _ask(requests: list[dict]) -> list[dict]:
    lines = "".join(json.dumps({"id": str(i), **r}) + "\n" for i, r in enumerate(requests))
    done = subprocess.run([str(SIDECAR_PYTHON), "-I", str(WORKER)], input=lines, capture_output=True, text=True,
                          timeout=180, check=True)
    replies = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
    return replies[1:]  # the first line is the ready banner


@pytest.fixture(scope="module", params=SPECS)
def plans(request: pytest.FixtureRequest) -> dict[str, dict]:
    manifest = str(FIXTURES / request.param / "semantic_manifest.json")
    queries = {
        "simple": {"metrics": ["completed_revenue"], "group_by": ["metric_time__month", "customer__region"],
                   "start": "2026-01-01", "end": "2026-03-31"},
        "ratio": {"metrics": ["avg_order_value"], "group_by": ["metric_time__month"]},
        "derived": {"metrics": ["revenue_per_buyer"], "group_by": ["metric_time__month"]},
        "cumulative": {"metrics": ["cumulative_revenue"], "group_by": ["metric_time__month"]},
    }
    replies = _ask([{"op": "explain_plan", "manifest_path": manifest, "dialect": "duckdb", **q} for q in queries.values()])
    for reply in replies:
        assert reply["ok"], reply
    return {name: reply["result"] for name, reply in zip(queries, replies, strict=True)}


def _kinds(result: dict) -> list[str]:
    return [n["kind"] for n in result["plan"]]


def test_simple_metric_plan_reads_joins_filters_and_aggregates(plans: dict[str, dict]) -> None:
    result = plans["simple"]
    assert "plan_error" not in result
    kinds = _kinds(result)
    for kind in ("read", "metric_time", "constrain_time", "join", "filter", "aggregate", "compute"):
        assert kind in kinds
    assert kinds.index("read") < kinds.index("join") < kinds.index("filter") < kinds.index("aggregate")
    join = next(n for n in result["plan"] if n["kind"] == "join")
    assert join["left_models"] == ["orders"]
    assert join["targets"] == [{"entity": "customer", "join_type": "left_outer", "semantic_models": ["customers"]}]
    ids = {n["id"] for n in result["plan"]}
    assert all(i in ids for n in result["plan"] for i in n["inputs"])
    assert next(n for n in result["plan"] if n["kind"] == "filter")["filters"] == ["order_id__status = 'completed'"]


def test_simple_metric_inputs_and_group_bys_are_resolved(plans: dict[str, dict]) -> None:
    result = plans["simple"]
    assert result["inputs"] == [{
        "metric": "completed_revenue", "via": "completed_revenue", "semantic_model": "orders", "expr": "amount",
        "agg": "sum", "agg_time_dimension": "order_date",
        "filters": ["{{ Dimension('order_id__status') }} = 'completed'"],
    }]
    by_name = {g["name"]: g for g in result["group_by"]}
    assert by_name["customer__region"] == {"name": "customer__region", "kind": "dimension", "element": "region",
                                           "entity_links": ["customer"], "semantic_model": "customers", "expr": "region"}
    assert by_name["metric_time__month"]["kind"] == "metric_time"
    assert set(result["models"]) == {"orders", "customers"}
    assert result["models"]["customers"]["relation"] == '"bench"."main"."dim_customers"'
    assert {"name": "customer", "type": "primary", "expr": "customer_id"} in result["models"]["customers"]["entities"]
    assert result["time_range"]["start"].startswith("2026-01-01")


def test_ratio_metric_inputs_are_numerator_and_denominator(plans: dict[str, dict]) -> None:
    result = plans["ratio"]
    assert [(i["metric"], i["via"]) for i in result["inputs"]] == [
        ("revenue", "avg_order_value"), ("order_count", "avg_order_value")]
    assert _kinds(result).count("compute") >= 2  # the inputs, then the ratio
    ratio = result["metric_defs"]["avg_order_value"]
    assert ratio["type"] == "ratio"
    assert [(i["role"], i["name"]) for i in ratio["inputs"]] == [("numerator", "revenue"), ("denominator", "order_count")]
    assert result["metric_defs"]["revenue"]["type"] == "simple"


def test_derived_metric_inputs(plans: dict[str, dict]) -> None:
    result = plans["derived"]
    assert {i["metric"] for i in result["inputs"]} == {"revenue", "buyers"}
    buyers = next(i for i in result["inputs"] if i["metric"] == "buyers")
    assert buyers["agg"] == "count_distinct" and buyers["expr"] == "customer_id"
    derived = result["metric_defs"]["revenue_per_buyer"]
    assert derived["expr"] == "revenue / buyers"
    assert [(i["name"], i["alias"], i["offset"]) for i in derived["inputs"]] == [("revenue", None, False), ("buyers", None, False)]
    assert "combine" in _kinds(result) or _kinds(result).count("aggregate") >= 1


def test_cumulative_metric_joins_over_time(plans: dict[str, dict]) -> None:
    result = plans["cumulative"]
    assert [i["metric"] for i in result["inputs"]] == ["revenue"]
    assert "join_over_time" in _kinds(result)


def test_explain_plan_needs_metrics() -> None:
    manifest = str(FIXTURES / "dbt_1_12" / "semantic_manifest.json")
    [reply] = _ask([{"op": "explain_plan", "manifest_path": manifest, "dialect": "duckdb", "metrics": []}])
    assert reply == {"id": "0", "ok": False, "error": {"code": "bad_request", "message": "debugging needs at least one metric"}}
