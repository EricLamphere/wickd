import json
import os
import textwrap
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.main import app
from app.projects import search
from app.projects.search import IndexedNode, ProjectIndex, build_index, manifest_index, search_nodes


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _write_manifest(project: Path, data: dict) -> Path:
    target = project / "target"
    target.mkdir(parents=True, exist_ok=True)
    path = target / "manifest.json"
    path.write_text(json.dumps(data))
    return path


def _make_project(root: Path, subdir: str, name: str) -> Path:
    d = root / subdir
    d.mkdir(parents=True)
    (d / "dbt_project.yml").write_text(textwrap.dedent(f"name: {name}\nprofile: p\n"))
    return d


def _model(name: str, package: str = "shop", columns: tuple[str, ...] = (), description: str = "") -> dict:
    return {
        "resource_type": "model",
        "name": name,
        "package_name": package,
        "original_file_path": f"models/{name}.sql",
        "description": description,
        "columns": {c: {"name": c, "description": "", "data_type": None} for c in columns},
    }


MANIFEST = {
    "nodes": {
        "model.shop.fct_orders": _model("fct_orders", columns=("order_id", "customer_id"), description="One row per order"),
        "model.shop.dim_customers": _model("dim_customers", columns=("customer_id", "email")),
        "model.shop.stg_orders": _model("stg_orders", columns=("id",)),
        "model.dbt_utils.orders_util": _model("orders_util", package="dbt_utils"),
        "seed.shop.country_codes": {"resource_type": "seed", "name": "country_codes", "package_name": "shop"},
        "test.shop.not_null_fct_orders_order_id": {"resource_type": "test", "name": "not_null_fct_orders_order_id"},
        "analysis.shop.orders_scratch": {"resource_type": "analysis", "name": "orders_scratch"},
    },
    "sources": {
        "source.shop.raw.orders": {
            "name": "orders",
            "source_name": "raw",
            "package_name": "shop",
            "original_file_path": "models/sources.yml",
            "columns": {"ORDER_ID": {"name": "ORDER_ID"}},
        },
    },
    "exposures": {
        "exposure.shop.orders_dashboard": {"name": "orders_dashboard", "package_name": "shop"},
    },
}


# ── build_index ───────────────────────────────────────────────────────────────


def test_build_index_keeps_searchable_types_only() -> None:
    index = build_index(MANIFEST)
    types = {n.unique_id: n.resource_type for n in index}
    assert types == {
        "model.shop.fct_orders": "model",
        "model.shop.dim_customers": "model",
        "model.shop.stg_orders": "model",
        "model.dbt_utils.orders_util": "model",
        "seed.shop.country_codes": "seed",
        "source.shop.raw.orders": "source",
        "exposure.shop.orders_dashboard": "exposure",
    }


def test_build_index_names_sources_with_source_name() -> None:
    by_id = {n.unique_id: n for n in build_index(MANIFEST)}
    src = by_id["source.shop.raw.orders"]
    assert src.name == "raw.orders"
    assert src.columns == ("ORDER_ID",)
    assert by_id["model.shop.fct_orders"].columns == ("order_id", "customer_id")
    assert by_id["model.shop.fct_orders"].description == "One row per order"


def test_build_index_tolerates_malformed_entries() -> None:
    data = {
        "nodes": {"model.x.a": "not a dict", "model.x.b": {"resource_type": "model"}, "model.x.c": {"resource_type": "model", "name": "c", "columns": []}},
        "sources": None,
    }
    index = build_index(data)
    assert [n.name for n in index] == ["c"]
    assert index[0].columns == ()


def test_build_index_truncates_long_descriptions() -> None:
    data = {"nodes": {"model.x.a": {"resource_type": "model", "name": "a", "description": "x" * 1000}}}
    assert len(build_index(data)[0].description) <= search.MAX_DESCRIPTION + 1


# ── search_nodes ──────────────────────────────────────────────────────────────


def _projects() -> list[ProjectIndex]:
    return [ProjectIndex(project_id=1, project_name="shop", nodes=build_index(MANIFEST))]


def test_search_ranks_exact_then_prefix_then_substring() -> None:
    hits = search_nodes(_projects(), "orders", limit=50)
    names = [h.name for h in hits]
    # exact source table name first, then prefix (orders_*), then substrings
    assert names[0] == "raw.orders"
    assert names.index("orders_dashboard") < names.index("fct_orders")
    assert set(names) == {"raw.orders", "orders_dashboard", "orders_util", "fct_orders", "stg_orders"}


def test_search_matches_columns_case_insensitively() -> None:
    hits = search_nodes(_projects(), "CUSTOMER_ID", limit=50)
    assert {(h.name, h.matched_column) for h in hits} == {
        ("fct_orders", "customer_id"),
        ("dim_customers", "customer_id"),
    }


def test_name_match_beats_column_match_and_has_no_column() -> None:
    hits = search_nodes(_projects(), "order_id", limit=50)
    assert all(h.matched_column is not None for h in hits)
    hits = search_nodes(_projects(), "fct_orders", limit=50)
    assert hits[0].name == "fct_orders"
    assert hits[0].matched_column is None


def test_search_prefers_root_package_on_ties() -> None:
    hits = search_nodes(_projects(), "orders_", limit=50)
    names = [h.name for h in hits]
    assert names.index("orders_dashboard") < names.index("orders_util")


def test_search_across_projects_and_limit() -> None:
    projects = [
        ProjectIndex(project_id=1, project_name="shop", nodes=build_index(MANIFEST)),
        ProjectIndex(
            project_id=2,
            project_name="other",
            nodes=(IndexedNode("model.other.fct_orders", "fct_orders", "model", "other", None, "", ()),),
        ),
    ]
    hits = search_nodes(projects, "fct_orders", limit=50)
    assert {(h.project_id, h.name) for h in hits} == {(1, "fct_orders"), (2, "fct_orders")}
    assert len(search_nodes(projects, "o", limit=3)) == 3


def test_blank_query_returns_nothing() -> None:
    assert search_nodes(_projects(), "   ", limit=50) == []


# ── manifest_index cache ──────────────────────────────────────────────────────


def test_manifest_index_missing_or_bad(tmp_path: Path) -> None:
    assert manifest_index(tmp_path) is None
    (tmp_path / "target").mkdir()
    (tmp_path / "target" / "manifest.json").write_text("{not json")
    assert manifest_index(tmp_path) is None


def test_manifest_index_cached_until_file_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = _write_manifest(tmp_path, MANIFEST)
    first = manifest_index(tmp_path)
    assert first is not None

    calls = 0
    real_loads = search.json.loads

    def counting_loads(*args, **kwargs):
        nonlocal calls
        calls += 1
        return real_loads(*args, **kwargs)

    monkeypatch.setattr(search.json, "loads", counting_loads)
    assert manifest_index(tmp_path) == first
    assert calls == 0

    _write_manifest(tmp_path, {"nodes": {"model.p.only": _model("only")}})
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    assert [n.name for n in manifest_index(tmp_path) or ()] == ["only"]
    assert calls == 1


# ── endpoint ──────────────────────────────────────────────────────────────────


async def test_search_endpoint(client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "dbt_projects_path", tmp_path)
    shop = _make_project(tmp_path, "shop", "shop")
    _make_project(tmp_path, "fresh", "fresh")
    hidden = _make_project(tmp_path, "hidden", "hidden")
    _write_manifest(shop, MANIFEST)
    _write_manifest(hidden, MANIFEST)

    projects = (await client.get("/api/projects")).json()
    ids = {p["name"]: p["id"] for p in projects}
    await client.patch(f"/api/projects/{ids['hidden']}/ignore", json={"ignored": True})

    resp = await client.get("/api/projects/search", params={"q": "customer_id"})
    assert resp.status_code == 200
    body = resp.json()
    assert {(h["project_name"], h["name"], h["matched_column"]) for h in body["hits"]} == {
        ("shop", "fct_orders", "customer_id"),
        ("shop", "dim_customers", "customer_id"),
    }
    hit = body["hits"][0]
    assert hit["project_id"] == ids["shop"]
    assert hit["resource_type"] == "model"
    assert hit["original_file_path"].startswith("models/")
    assert body["unindexed_project_ids"] == [ids["fresh"]]
    assert body["truncated"] is False


async def test_search_endpoint_truncates(client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "dbt_projects_path", tmp_path)
    _write_manifest(_make_project(tmp_path, "shop", "shop"), MANIFEST)
    await client.get("/api/projects")

    body = (await client.get("/api/projects/search", params={"q": "o", "limit": 2})).json()
    assert len(body["hits"]) == 2
    assert body["truncated"] is True


async def test_search_endpoint_validates_query(client: AsyncClient) -> None:
    assert (await client.get("/api/projects/search")).status_code == 422
    assert (await client.get("/api/projects/search", params={"q": ""})).status_code == 422
    assert (await client.get("/api/projects/search", params={"q": "x" * 201})).status_code == 422
