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

    def _prompt(manifest, uid, columns, stats, existing):
        state["prompt"] = {"columns": columns, "stats": stats, "existing": existing}
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
