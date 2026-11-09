"""Unit test generation (plan 19): context helpers (pure) and the generator with dbt stubbed.

The generator test uses the real wickd_pro engine when it's installed (skipped otherwise),
with `dbt compile` / `dbt show` / the column probe replaced by canned answers.
"""

import json
from pathlib import Path

import pytest

from app.dbt.probe import ProbeResult
from app.dbt.unit_test_diff import parse_unit_test_diff
from app.unit_tests import context, generation
from app.unit_tests.context import (
    UnitTestError,
    check_model,
    dbt_version_ok,
    fixture_format,
    model_inputs,
    parse_compiled,
    target_file,
    unit_test_name,
)
from app.unit_tests.files import file_options, resolve_file
from app.unit_tests.rebaseline import actual_rows

UID = "model.proj.orders"


def _manifest(**node_overrides) -> dict:
    return {
        "metadata": {"dbt_version": "1.10.2", "adapter_type": "duckdb"},
        "nodes": {
            UID: {
                "resource_type": "model", "name": "orders", "original_file_path": "models/marts/orders.sql",
                "config": {"materialized": "table"}, "relation_name": '"db"."main"."orders"',
                "depends_on": {"nodes": ["model.proj.stg_orders", "source.proj.shop.customers"]},
                **node_overrides,
            },
            "model.proj.stg_orders": {
                "resource_type": "model", "name": "stg_orders", "relation_name": '"db"."main"."stg_orders"',
                "config": {"materialized": "view"},
            },
        },
        "sources": {
            "source.proj.shop.customers": {
                "resource_type": "source", "name": "customers", "source_name": "shop",
                "relation_name": '"db"."raw"."customers"',
            },
        },
        "unit_tests": {},
    }


def test_model_inputs():
    assert model_inputs(_manifest(), UID) == [
        {"key": "ref('stg_orders')", "relation": '"db"."main"."stg_orders"', "unique_id": "model.proj.stg_orders",
         "ephemeral": False},
        {"key": "source('shop', 'customers')", "relation": '"db"."raw"."customers"',
         "unique_id": "source.proj.shop.customers", "ephemeral": False},
    ]


def test_check_model_refusals():
    assert check_model(_manifest(), UID)["name"] == "orders"
    with pytest.raises(UnitTestError, match="ephemeral models"):
        check_model(_manifest(config={"materialized": "ephemeral"}), UID)
    old = _manifest()
    old["metadata"]["dbt_version"] = "1.7.4"
    with pytest.raises(UnitTestError, match="1.8"):
        check_model(old, UID)
    eph = _manifest()
    eph["nodes"]["model.proj.stg_orders"]["config"]["materialized"] = "ephemeral"
    with pytest.raises(UnitTestError, match="sql fixtures"):
        check_model(eph, UID)
    with pytest.raises(UnitTestError, match="only be generated for models"):
        check_model(_manifest(), "model.proj.nope")


def test_dbt_version_ok():
    assert dbt_version_ok("1.8.0") and dbt_version_ok("1.11.0b2") and dbt_version_ok(None)
    assert not dbt_version_ok("1.7.19")


def test_unit_test_name():
    assert unit_test_name("orders", None, set()) == "orders_logic"
    assert unit_test_name("orders", "case:Order State", {"orders_order_state"}) == "orders_order_state_2"
    assert unit_test_name("orders", "cte:joined", set()) == "orders_joined"


def test_fixture_format():
    manifest = _manifest()
    assert fixture_format(manifest) == "dict"
    manifest["unit_tests"] = {
        "a": {"given": [{"format": "csv"}, {"format": "csv"}]},
        "b": {"given": [{"format": "dict"}]},
    }
    assert fixture_format(manifest) == "csv"


def test_target_file(tmp_path: Path):
    (tmp_path / "models" / "marts").mkdir(parents=True)
    node = _manifest()["nodes"][UID]
    manifest = _manifest()
    assert target_file(tmp_path, manifest, node) == "models/marts/schema.yml"
    (tmp_path / "models" / "marts" / "_models.yml").write_text("version: 2\nmodels:\n  - name: orders\n")
    assert target_file(tmp_path, manifest, node) == "models/marts/_models.yml"
    manifest["unit_tests"] = {"u": {"model": "orders", "original_file_path": "models/tests.yml"}}
    assert target_file(tmp_path, manifest, node) == "models/tests.yml"


def test_resolve_file(tmp_path: Path):
    (tmp_path / "models" / "marts").mkdir(parents=True)
    model_file = "models/marts/orders.sql"
    assert resolve_file(tmp_path, "orders_tests", model_file) == "models/marts/orders_tests.yml"
    assert resolve_file(tmp_path, " my.yaml ", model_file) == "models/marts/my.yaml"
    assert resolve_file(tmp_path, "models/unit/all.yml", model_file) == "models/unit/all.yml"
    (tmp_path / "models" / "folder.yml").mkdir()
    for bad in ("", "../outside.yml", "/etc/x.yml", "seeds/x.yml", "models/folder.yml"):
        with pytest.raises(UnitTestError):
            resolve_file(tmp_path, bad, model_file)
    (tmp_path / "dbt_project.yml").write_text("name: p\nmodel-paths: ['transform']\n")
    assert resolve_file(tmp_path, "transform/x.yml", model_file) == "transform/x.yml"
    with pytest.raises(UnitTestError, match="transform/"):
        resolve_file(tmp_path, "models/x.yml", model_file)


def test_file_options(tmp_path: Path):
    (tmp_path / "models" / "marts").mkdir(parents=True)
    (tmp_path / "models" / "marts" / "_models.yml").write_text("version: 2\nmodels:\n  - name: orders\n")
    (tmp_path / "models" / "unit.yaml").write_text("version: 2\n")
    (tmp_path / "models" / "dbt_packages").mkdir()
    (tmp_path / "models" / "dbt_packages" / "x.yml").write_text("")
    manifest = _manifest()
    manifest["unit_tests"] = {"u": {"model": "orders", "original_file_path": "models/unit.yaml"}}
    options = file_options(tmp_path, manifest, manifest["nodes"][UID])
    assert options == {
        "default": "models/unit.yaml",
        "existing": ["models/unit.yaml"],
        "files": ["models/marts/_models.yml", "models/unit.yaml"],
        "model_dir": "models/marts",
    }


def test_parse_compiled():
    stdout = '16:17:54  Running with dbt=1.10\n{\n  "node": "orders",\n  "compiled": "select 1"\n}\n'
    assert parse_compiled(stdout) == "select 1"
    assert parse_compiled("no json") is None


def test_rebaseline_actual_rows_use_expected_types():
    diff = parse_unit_test_diff("actual differs from expected:\n\n@@ ,id,amount,code,flag\n→  ,1 ,5.0→4.0,7→8,true→false\n")
    assert diff is not None
    rows = actual_rows(diff, [{"id": 1, "amount": 5.0, "code": "7", "flag": True}])
    assert rows == [{"id": 1, "amount": 4.0, "code": "8", "flag": False}]


# ── the generator, dbt stubbed ───────────────────────────────────────────────

SQL = (
    'select o.id, case when o.status = \'done\' then 1 else 0 end as is_done '
    'from "db"."main"."stg_orders" o left join "db"."raw"."customers" c on o.customer_id = c.id'
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "models" / "marts").mkdir(parents=True)
    (tmp_path / "target").mkdir()
    (tmp_path / "target" / "manifest.json").write_text(json.dumps(_manifest()))
    return tmp_path


def _stub_dbt(monkeypatch, shown: list[str]) -> None:
    async def compile_model(project_id, project_path, name, env, full_refresh):
        return SQL

    async def probe(project_id, project_path, relations, env, target):
        return {
            "ref('stg_orders')": ProbeResult(("id", "customer_id", "status"), None, ("INTEGER", "INTEGER", "VARCHAR")),
            "source('shop', 'customers')": ProbeResult(("id", "name"), None, ("INTEGER", "VARCHAR")),
        }

    async def show_inline(project_id, project_path, env, sql, limit):
        shown.append(sql)
        if "__wickd_fixture" in sql:  # the expectation query
            return ["id", "is_done"], [[1, 1], [2, 0]]
        if "customers" in sql.split("FROM")[1]:
            return ["id", "name", "__wickd_branch"], [[10, "Ann", 0]]
        return ["id", "customer_id", "status", "__wickd_branch"], [[1, 10, "done", 0], [2, 99, "open", 3]]

    monkeypatch.setattr(generation, "compile_model", compile_model)
    monkeypatch.setattr(generation, "probe_relations", probe)
    monkeypatch.setattr(generation, "show_inline", show_inline)


async def test_generate_with_engine(project: Path, monkeypatch):
    pytest.importorskip("wickd_pro.unit_tests")
    shown: list[str] = []
    _stub_dbt(monkeypatch, shown)
    phases: list[str] = []

    async def on_phase(p: str) -> None:
        phases.append(p)

    result = await generation.generate_unit_test(
        project_id=1, project_path=project, unique_id=UID, env={}, on_phase=on_phase, focus="case:is_done",
    )
    assert phases == ["columns", "sampling", "expecting", "writing"]
    assert result.change.path == "models/marts/schema.yml" and result.change.original is None
    assert "  - name: orders_is_done\n" in result.change.proposed
    assert "- {id: 1, customer_id: 10, status: done}" in result.change.proposed
    assert "input: source('shop', 'customers')" in result.change.proposed
    summary = result.summary
    assert summary["expected"] == {"columns": ["id", "is_done"], "rows": [[1, 1], [2, 0]]}
    assert summary["branches"] == ["status = 'done'"]
    assert len(shown) == 3  # orders, then customers for the picked keys, then the expectation
    assert "IN (10, 99)" in shown[1]
    chosen = await generation.generate_unit_test(
        project_id=1, project_path=project, unique_id=UID, env={}, file="orders_checks",
    )
    assert chosen.change.path == "models/marts/orders_checks.yml"


async def test_generate_refuses_when_inputs_not_built(project: Path, monkeypatch):
    pytest.importorskip("wickd_pro.unit_tests")
    _stub_dbt(monkeypatch, [])

    async def probe(*args):
        return {"ref('stg_orders')": ProbeResult((), "x", not_built=True),
                "source('shop', 'customers')": ProbeResult(("id",), None)}

    monkeypatch.setattr(generation, "probe_relations", probe)
    with pytest.raises(UnitTestError, match="isn't built"):
        await generation.generate_unit_test(project_id=1, project_path=project, unique_id=UID, env={})


def test_raw_wraps_jinja():
    assert context.raw("select '{{x}}'") == "{% raw %}select '{{x}}'{% endraw %}"


def test_rebaseline_keeps_rows_the_diff_left_out():
    message = (
        "actual differs from expected:\n\n@@ ,id ,state,day\n...,...,...  ,...\n"
        "→  ,2  ,open→back,2024-01-02\n---,5  ,gone ,2024-01-05\n"
        "+++,4  ,new  ,\"datetime.date(2024, 1, 4)\"\n"
    )
    diff = parse_unit_test_diff(message)
    assert diff is not None
    expected = [
        {"id": 1, "state": "done", "day": "2024-01-01"},
        {"id": 2, "state": "open", "day": "2024-01-02"},
        {"id": 5, "state": "gone", "day": "2024-01-05"},
    ]
    assert actual_rows(diff, expected) == [
        {"id": 1, "state": "done", "day": "2024-01-01"},  # elided: unchanged, kept
        {"id": 2, "state": "back", "day": "2024-01-02"},
        {"id": 4, "state": "new", "day": "2024-01-04"},
    ]


def test_query_error_picks_the_warehouse_message():
    output = (
        "16:54:23  Encountered an error:\nRuntime Error\n"
        "  Runtime Error in sql_operation inline_query (from remote system.sql)\n"
        '    Parser Error: syntax error at or near "AS"\n    LINE 4: ... AS top_traffic_category\n'
    )
    assert context.query_error(output) == 'Parser Error: syntax error at or near "AS"'
    assert context.query_error("Runtime Error\n  something went wrong\n") == "something went wrong"
    assert context.query_error("") == "unknown error"
