import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import yaml

from app.ai import pro, test_generation
from app.ai.catalog import MODELS
from app.ai.client import Provider
from app.ai.config import AiConfig
from app.ai.errors import NothingToPropose
from app.ai.test_generation import check_sql, column_stats, generate_tests, to_spec
from app.dbt.probe import ProbeResult
from app.dbt.schema_tests import DataTestSpec

UID = "model.proj.orders"
CONFIG = AiConfig(model=MODELS[0], endpoint_url=None, endpoint_model=None)


def test_column_stats():
    stats = column_stats(
        ["id", "status", "amount", "note"],
        [[1, "placed", 10, None], [2, "shipped", 2.5, None], [3, "placed", 7, "x"]],
    )
    assert stats["id"] == {"rows": 3, "nulls": 0, "distinct": 3, "numeric": True, "values": None}
    assert stats["status"]["values"] == ["placed", "shipped"]
    assert stats["amount"]["numeric"] is True
    assert stats["note"]["nulls"] == 2 and stats["note"]["values"] is None


def test_to_spec_numeric_accepted_values_and_relationship_target():
    manifest = {
        "nodes": {"model.proj.customers": {"name": "customers", "resource_type": "model"}},
        "sources": {"source.proj.raw.c": {"name": "c", "source_name": "raw", "resource_type": "source"}},
    }
    stats = {"code": {"numeric": True}}
    assert to_spec({"test": "accepted_values", "column": "code", "values": ["1", "2"]}, manifest, stats) == (
        DataTestSpec("accepted_values", {"values": [1, 2], "quote": False})
    )
    assert to_spec({"test": "accepted_values", "column": "s", "values": ["a"]}, manifest, {}).args == {"values": ["a"]}
    rel = to_spec({"test": "relationships", "column": "c", "to": "model.proj.customers", "field": "id"}, manifest, {})
    assert rel.args == {"to": "ref('customers')", "field": "id"}
    src = to_spec({"test": "relationships", "column": "c", "to": "source.proj.raw.c", "field": "id"}, manifest, {})
    assert src.args["to"] == "source('raw', 'c')"
    assert to_spec({"test": "relationships", "column": "c", "to": "model.proj.gone", "field": "id"}, manifest, {}) is None


def test_check_sql_one_query_for_all_tests():
    sql = check_sql("ref('orders')", [
        ({"column": "id"}, DataTestSpec("unique")),
        ({"column": "status"}, DataTestSpec("accepted_values", {"values": ["a", "it's"]})),
        ({"column": "cid"}, DataTestSpec("relationships", {"to": "ref('customers')", "field": "id"})),
    ])
    assert sql.count("union all") == 2
    assert "select 0 as wickd_test" in sql and "having count(*) > 1" in sql
    assert "not in ('a', 'it''s')" in sql
    assert "left join {{ ref('customers') }} parent on child.cid = parent.id" in sql


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    (root / "models").mkdir(parents=True)
    (root / "target").mkdir()
    manifest = {
        "metadata": {"dbt_version": "1.9.1"},
        "nodes": {
            UID: {"name": "orders", "resource_type": "model", "original_file_path": "models/orders.sql",
                  "columns": {}},
            "test.proj.unique_orders_id.1": {
                "name": "unique_orders_id", "resource_type": "test", "attached_node": UID,
                "column_name": "id", "test_metadata": {"name": "unique"},
            },
        },
    }
    (root / "target" / "manifest.json").write_text(json.dumps(manifest))
    return root


@pytest.fixture
def fake_model(monkeypatch):
    state: dict = {"suggested": [], "shows": []}

    def _prompt(manifest, uid, columns, stats, existing, candidates=None):
        state["prompt"] = {"columns": columns, "stats": stats, "existing": existing, "candidates": candidates}
        return {"messages": [], "schema": {}, "max_tokens": 10}

    async def _stream(provider, messages, max_tokens=None, schema=None):
        yield '{"tests": []}'

    async def _show(project_id, project_path, env, extra, select):
        state["shows"].append((extra, select))
        if select == "orders":  # the data sample
            return ["id", "status"], [[1, "placed"], [2, "shipped"], [3, "placed"]]
        return ["wickd_test", "failures"], [[0, 0], [1, 2]]  # the pre-check

    monkeypatch.setattr(pro, "suggest_tests_prompt", _prompt)
    monkeypatch.setattr(pro, "parse_suggested_tests", lambda *a: state["suggested"])
    monkeypatch.setattr(test_generation, "stream_chat", _stream)
    monkeypatch.setattr(test_generation, "_show", _show)
    monkeypatch.setattr(
        test_generation, "resolve_provider", AsyncMock(return_value=Provider("http://x/v1", "m"))
    )
    monkeypatch.setattr(test_generation, "llm_ready", lambda config: state.get("llm_ready", True))
    from app.ai import documentation
    monkeypatch.setattr(
        documentation, "probe_warehouse_columns",
        AsyncMock(return_value=ProbeResult(columns=("id", "status"), error=None)),
    )
    return state


async def _generate(root: Path, **kw):
    return await generate_tests(project_id=1, project_path=root, unique_id=UID, env={}, config=CONFIG, **kw)


async def test_generates_prechecked_tests_into_new_yaml(tmp_path, fake_model):
    root = _project(tmp_path)
    fake_model["suggested"] = [
        {"column": "id", "test": "not_null", "reason": "Primary key."},
        {"column": "status", "test": "accepted_values", "values": ["placed"], "reason": "Status."},
    ]
    phases = []

    async def on_phase(p):
        phases.append(p)

    result = await _generate(root, on_phase=on_phase)
    assert phases == ["columns", "sampling", "writing", "checking"]
    assert fake_model["prompt"]["existing"] == [{"column": "id", "test": "unique"}]
    assert fake_model["prompt"]["stats"]["status"]["values"] == ["placed", "shipped"]

    cols = yaml.safe_load(result.change.proposed)["models"][0]["columns"]
    assert cols == [
        {"name": "id", "data_tests": ["not_null"]},
        {"name": "status", "data_tests": [{"accepted_values": {"values": ["placed"]}}]},
    ]
    assert [t["failures"] for t in result.summary["tests"]] == [0, 2]
    assert result.summary["tests"][1]["values"] == ["placed"]
    assert not (root / "models" / "schema.yml").exists()


async def test_nothing_new_is_reported(tmp_path, fake_model):
    with pytest.raises(NothingToPropose):
        await _generate(_project(tmp_path))


async def test_no_sample_skips_precheck(tmp_path, fake_model, monkeypatch):
    async def _no_show(*a):
        return None

    monkeypatch.setattr(test_generation, "_show", _no_show)
    fake_model["suggested"] = [{"column": "id", "test": "not_null", "reason": ""}]
    result = await _generate(_project(tmp_path))
    assert result.summary["tests"][0]["failures"] is None


def test_combination_spec_and_check_sql():
    test = {"column": None, "columns": ["day", "status"], "test": "unique_combination_of_columns"}
    spec = to_spec(test, {}, {})
    assert spec == DataTestSpec("dbt_utils.unique_combination_of_columns", {"combination_of_columns": ["day", "status"]})
    sql = check_sql("ref('daily')", [(test, spec)])
    assert "select day, status from {{ ref('daily') }} group by day, status having count(*) > 1" in sql


# ranking rows as app/test_targets/service.targets_for_model returns them
TARGETS = [
    {"unique_id": UID, "column": "ID", "score": 9, "candidates": [
        {"test": "unique", "evidence": "one row per `id` (grouped by)", "source": "grain"},
        {"test": "not_null", "evidence": "one row per `id` (grouped by)", "source": "grain"},
    ]},
    {"unique_id": UID, "column": "status", "score": 3, "candidates": [
        {"test": "relationships", "to": "model.proj.statuses", "field": "code",
         "evidence": "joined to `statuses.code` in 2 models", "source": "join"},
    ]},
    {"unique_id": UID, "column": None, "columns": ["id", "status"], "score": 9, "candidates": [
        {"test": "unique_combination_of_columns", "combination": ["id", "status"],
         "evidence": "one row per (id, status)", "source": "grain"},
    ]},
    {"unique_id": UID, "column": "gone", "score": 1, "candidates": [{"test": "not_null", "evidence": "x"}]},
]


def _with_statuses(root: Path) -> Path:
    path = root / "target" / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["nodes"]["model.proj.statuses"] = {"name": "statuses", "resource_type": "model"}
    path.write_text(json.dumps(manifest))
    return root


async def test_lineage_tests_without_an_ai_model(tmp_path, fake_model):
    fake_model["llm_ready"] = False
    phases = []

    async def on_phase(p):
        phases.append(p)

    result = await _generate(_with_statuses(_project(tmp_path)), targets=TARGETS, on_phase=on_phase)
    assert "writing" not in phases and "prompt" not in fake_model
    tests = result.summary["tests"]
    # `unique` on id already exists; `gone` isn't a real column
    assert [(t["column"], t["test"]) for t in tests] == [
        ("id", "not_null"), ("status", "relationships"), (None, "unique_combination_of_columns"),
    ]
    assert all(t["source"] == "lineage" for t in tests)
    assert tests[1]["evidence"] == "joined to `statuses.code` in 2 models"
    assert tests[1]["to"] == "statuses"
    assert tests[2]["columns"] == ["id", "status"]
    assert result.summary["note"] == test_generation.LINEAGE_ONLY_NOTE
    model = yaml.safe_load(result.change.proposed)["models"][0]
    assert model["data_tests"] == [
        {"dbt_utils.unique_combination_of_columns": {"combination_of_columns": ["id", "status"]}},
    ]
    assert model["columns"][1]["data_tests"] == [
        {"relationships": {"to": "ref('statuses')", "field": "code"}},
    ]


async def test_lineage_tests_then_ai_suggestions(tmp_path, fake_model):
    fake_model["suggested"] = [{"column": "status", "test": "accepted_values", "values": ["placed"], "reason": "s"}]
    result = await _generate(_with_statuses(_project(tmp_path)), targets=TARGETS)
    assert fake_model["prompt"]["candidates"] == TARGETS
    assert {"column": "status", "test": "relationships"} in fake_model["prompt"]["existing"]
    assert [t["source"] for t in result.summary["tests"]] == ["lineage", "lineage", "lineage", "ai"]
    assert "note" not in result.summary


async def test_ai_failure_keeps_lineage_tests(tmp_path, fake_model, monkeypatch):
    from app.ai.runtime import RuntimeUnavailable

    monkeypatch.setattr(test_generation, "resolve_provider", AsyncMock(side_effect=RuntimeUnavailable("no server")))
    result = await _generate(_with_statuses(_project(tmp_path)), targets=TARGETS)
    assert len(result.summary["tests"]) == 3
    assert "no server" in result.summary["note"]


async def test_ai_failure_without_lineage_tests_still_fails(tmp_path, fake_model, monkeypatch):
    from app.ai.runtime import RuntimeUnavailable

    monkeypatch.setattr(test_generation, "resolve_provider", AsyncMock(side_effect=RuntimeUnavailable("no server")))
    with pytest.raises(RuntimeUnavailable):
        await _generate(_project(tmp_path))
