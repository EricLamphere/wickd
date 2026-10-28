"""Semantic models, metrics and saved queries read from real dbt 1.7–1.12 manifests."""

from pathlib import Path

import pytest

from app.dbt.manifest import load_manifest
from app.dbt.semantic_nodes import where_text

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"
VERSIONS = ["dbt_1_7", "dbt_1_10", "dbt_1_12", "dbt_1_12_latest"]


def _load(version: str):
    manifest = load_manifest(FIXTURES / version / "manifest.json")
    assert manifest is not None
    return manifest, {n.unique_id: n for n in manifest.nodes}


@pytest.mark.parametrize("version", VERSIONS)
def test_semantic_nodes_are_graph_nodes(version: str) -> None:
    manifest, by_id = _load(version)
    sm = by_id["semantic_model.mf_bench.orders"]
    assert sm.resource_type == "semantic_model"
    assert sm.original_file_path == "models/semantic.yml"
    assert sm.semantic["model"] == "stg_orders"
    assert sm.semantic["relation_name"] == '"bench"."main"."stg_orders"'
    assert {e["name"] for e in sm.semantic["entities"]} == {"order_id", "customer"}
    order_date = next(d for d in sm.semantic["dimensions"] if d["name"] == "order_date")
    assert order_date["time_granularity"] == "day"

    assert by_id["metric.mf_bench.revenue"].label == "Revenue"
    assert by_id["saved_query.mf_bench.weekly_revenue_by_region"].semantic["metrics"] == ["revenue", "order_count"]

    edges = set(manifest.edges())
    assert ("model.mf_bench.stg_orders", "semantic_model.mf_bench.orders") in edges
    assert ("semantic_model.mf_bench.orders", "metric.mf_bench.revenue") in edges
    assert ("metric.mf_bench.revenue", "metric.mf_bench.revenue_per_buyer") in edges
    assert ("metric.mf_bench.revenue", "saved_query.mf_bench.weekly_revenue_by_region") in edges


@pytest.mark.parametrize("version", VERSIONS)
def test_metric_details(version: str) -> None:
    _, by_id = _load(version)
    completed = by_id["metric.mf_bench.completed_revenue"].semantic
    assert completed["type"] == "simple"
    assert completed["filter"] == "{{ Dimension('order_id__status') }} = 'completed'"

    ratio = by_id["metric.mf_bench.avg_order_value"].semantic
    assert ratio["numerator"] == "revenue" and ratio["denominator"] == "order_count"
    assert ratio["input_metrics"] == ["revenue", "order_count"]

    derived = by_id["metric.mf_bench.revenue_per_buyer"].semantic
    assert derived["expr"] == "revenue / buyers"
    assert derived["input_metrics"] == ["revenue", "buyers"]


def test_legacy_spec_simple_metric_has_measure() -> None:
    _, by_id = _load("dbt_1_10")
    revenue = by_id["metric.mf_bench.revenue"].semantic
    assert revenue["measure"] == "revenue"
    assert revenue["agg"] is None


def test_latest_spec_simple_metric_has_agg_and_cumulative_input() -> None:
    _, by_id = _load("dbt_1_12_latest")
    revenue = by_id["metric.mf_bench.revenue"].semantic
    assert revenue["measure"] is None
    assert (revenue["agg"], revenue["expr"], revenue["semantic_model"]) == ("sum", "amount", "orders")
    assert by_id["metric.mf_bench.cumulative_revenue"].semantic["input_metrics"] == ["revenue"]


def test_malformed_semantic_sections_are_skipped(tmp_path: Path) -> None:
    path = tmp_path / "manifest.json"
    path.write_text(
        '{"nodes": {}, "semantic_models": [], "metrics": {"metric.p.x": "nope", '
        '"metric.p.y": {"name": "y", "type_params": "bad", "filter": 3}}, "saved_queries": null}'
    )
    manifest = load_manifest(path)
    assert [n.unique_id for n in manifest.nodes] == ["metric.p.y"]
    assert manifest.nodes[0].semantic["input_metrics"] == []


def test_where_text_variants() -> None:
    assert where_text(None) is None
    assert where_text("a = 1") == "a = 1"
    assert where_text({"where_filters": [{"where_sql_template": "a"}, {"where_sql_template": "b"}]}) == "a AND b"
    assert where_text([{"where_sql_template": "c"}]) == "c"


async def test_docs_data_includes_semantic_nodes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from httpx import ASGITransport, AsyncClient

    from app.api import docs
    from app.main import app

    docs_dir = tmp_path / "docs" / "1"
    docs_dir.mkdir(parents=True)
    data = json.loads((FIXTURES / "dbt_1_12" / "manifest.json").read_text())
    child_map: dict[str, list[str]] = {}
    for child, parents in data["parent_map"].items():
        for parent in parents:
            child_map.setdefault(parent, []).append(child)
    (docs_dir / "manifest.json").write_text(json.dumps({**data, "child_map": child_map}))
    monkeypatch.setattr(docs, "_docs_dir", lambda project_id: docs_dir)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/projects/1/docs/data")
    assert resp.status_code == 200
    by_id = {n["unique_id"]: n for n in resp.json()["nodes"]}
    sm = by_id["semantic_model.mf_bench.orders"]
    assert sm["relation_name"] == '"bench"."main"."stg_orders"'
    assert sm["semantic"]["model"] == "stg_orders"
    metric = by_id["metric.mf_bench.revenue"]
    assert metric["label"] == "Revenue"
    assert "saved_query.mf_bench.weekly_revenue_by_region" in metric["child_models"]
    assert by_id["saved_query.mf_bench.weekly_revenue_by_region"]["semantic"]["metrics"] == ["revenue", "order_count"]
