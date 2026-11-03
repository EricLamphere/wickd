"""Data diff (plan 06) public helpers: key resolution, connection identity, strategy per model,
the batching driver and the plain SQL filter check. All pure or with fakes."""

import pytest

from app.data_diff import prepare
from app.data_diff.driver import run_all
from app.data_diff.keys import grain_of, resolve_key
from app.data_diff.prepare import ModelPlan
from app.dbt.connection_info import TargetConnection, parse_connection_block, same_instance
from app.dbt.probe import ProbeResult
from app.semantic.query_spec import QueryInvalid, check_sql_condition

UID = "model.p.orders"


def _manifest(**node) -> dict:
    return {"nodes": {UID: {"name": "orders", "resource_type": "model", **node}}}


def _test(name: str, **kwargs) -> dict:
    return {"resource_type": "test", "attached_node": UID, "test_metadata": {"name": name, "kwargs": kwargs}}


# ── keys ──────────────────────────────────────────────────────────────────────


def test_key_order_contract_then_tests_then_grain():
    m = _manifest(constraints=[{"type": "primary_key", "columns": ["order_id"]}])
    m["nodes"]["test.p.u"] = _test("unique", column_name="other_id")
    cols = {"ORDER_ID", "other_id", "day"}
    assert resolve_key(m, UID, available=cols).columns == ("ORDER_ID",)  # case-insensitive, warehouse casing
    assert resolve_key(m, UID, available=cols).source == "contract"
    assert resolve_key(m, UID, available=cols, user=["day"]).source == "user"
    del m["nodes"][UID]["constraints"]
    assert resolve_key(m, UID, available=cols).columns == ("other_id",)


def test_key_from_column_constraint_combination_and_grain():
    m = _manifest(columns={"id": {"name": "id", "constraints": [{"type": "primary_key"}]}})
    assert resolve_key(m, UID, available={"id"}).source == "contract"
    m = _manifest()
    m["nodes"]["test.p.c"] = _test("unique_combination_of_columns", combination_of_columns=["a", "b"])
    assert resolve_key(m, UID, available={"a", "b"}).source == "unique_combination"
    structure = {UID: {"grain": {"columns": ["day", "store"], "via": "group_by"}}}
    key = resolve_key(_manifest(), UID, available={"day", "store"}, grain=grain_of(structure, UID))
    assert key is not None and key.source == "detected"


def test_key_skips_expressions_and_missing_columns():
    m = _manifest()
    m["nodes"]["test.p.e"] = _test("unique", column_name="lower(email)")
    assert resolve_key(m, UID, available={"email"}) is None


# ── connection identity ───────────────────────────────────────────────────────

DEBUG = """\x1b[0m17:36:41  adapter type: duckdb
\x1b[0m17:36:41  Connection:
\x1b[0m17:36:41    database: prod
\x1b[0m17:36:41    schema: main
\x1b[0m17:36:41    path: prod.duckdb
\x1b[0m17:36:41    settings: {}
\x1b[0m17:36:41  Registered adapter: duckdb=1.10.1
\x1b[0m17:36:41    Connection test: [OK connection ok]
"""


def test_parse_connection_block():
    fields = parse_connection_block(DEBUG)
    assert fields == {"database": "prod", "schema": "main", "path": "prod.duckdb", "settings": "{}"}


def _conn(target: str, **fields) -> TargetConnection:
    return TargetConnection(target=target, adapter_type="x", fields=fields, connected=True)


def test_same_instance():
    assert same_instance(_conn("dev", path="dev.duckdb", database="dev"), _conn("prod", path="prod.duckdb")) is False
    # database / schema differ inside one instance
    assert same_instance(_conn("dev", account="acme", database="DEV"), _conn("prod", account="ACME", database="PROD"))
    assert same_instance(_conn("dev", project="a"), _conn("prod", project="b")) is None  # BigQuery: names are global


# ── strategy ──────────────────────────────────────────────────────────────────


def _plan(dev_rel: str, prod_rel: str) -> ModelPlan:
    return ModelPlan(UID, "orders", dev_relation=dev_rel, prod_relation=prod_rel)


async def test_modes_from_identity_and_access_probe():
    calls = []

    async def run(side, sqls):
        calls.append((side, sqls))
        return [{"error": "permission denied"} if "secret" in s else {"columns": ["id"], "rows": []} for s in sqls]

    plans = [_plan("dev.a.orders", "prod.a.orders"), _plan("dev.a.x", "secret.a.x"), _plan("same.t", "same.t")]
    await prepare.choose_modes(plans, _conn("dev", account="a"), _conn("prod", account="a"), run, "auto")
    assert [p.mode for p in plans[:2]] == ["joined", "separate"]
    assert "permission denied" in plans[1].notes[-1]
    assert plans[2].error["code"] == "same_relation"
    assert calls == [("dev", ["select * from prod.a.orders where 1 = 0", "select * from secret.a.x where 1 = 0"])]


async def test_modes_different_instance_skips_probe():
    async def run(side, sqls):
        raise AssertionError("no probe needed")

    plans = [_plan("a", "b"), _plan("same", "same")]
    await prepare.choose_modes(plans, _conn("dev", path="dev.duckdb"), _conn("prod", path="prod.duckdb"), run, "auto")
    assert [p.mode for p in plans] == ["separate", "separate"]
    assert "`path` differs" in plans[0].notes[0]


async def test_forced_separate():
    plans = [_plan("a", "b")]
    await prepare.choose_modes(plans, _conn("dev"), _conn("prod"), None, "separate")
    assert plans[0].mode == "separate"


def test_columns_and_missing_relations():
    plans = [_plan("a", "b"), _plan("c", "d")]
    plans[1].name = "gone"
    dev = {"orders": ProbeResult(columns=("id", "amt"), error=None, types=("int", "double")),
           "gone": ProbeResult(columns=(), error="not built", not_built=True)}
    prod = {"orders": ProbeResult(columns=("id",), error=None, types=("int",)),
            "gone": ProbeResult(columns=("id",), error=None, types=("int",))}
    prepare.apply_columns(plans, dev, prod, "dev", "prod")
    assert plans[0].dev_columns == [["id", "int"], ["amt", "double"]]
    assert plans[1].error["code"] == "dev_missing"
    p = ModelPlan(UID, "orders")
    prepare.apply_relations([p], {UID: "x"}, {UID: None}, "prod")
    assert p.error["code"] == "no_relation"


def test_new_plans_refuse_ephemeral_and_tests():
    m = {"nodes": {UID: {"name": "orders", "resource_type": "model", "config": {"materialized": "ephemeral"}},
                   "test.p.t": {"name": "t", "resource_type": "test"}}}
    plans = prepare.new_plans(m, [UID, "test.p.t"])
    assert [p.error["code"] for p in plans] == ["ephemeral", "not_a_model"]


# ── driver ────────────────────────────────────────────────────────────────────


def _gen(name: str, rounds: int):
    seen = []
    for i in range(rounds):
        got = yield {"dev": [f"{name}-dev-{i}"], "prod": [f"{name}-prod-{i}"] if i == 0 else []}
        seen.append(got)
    return {"name": name, "seen": seen}


async def test_driver_batches_every_model_per_connection():
    batches = []

    async def execute(side, sqls):
        batches.append((side, list(sqls)))
        return [{"columns": [], "rows": [[s]], "error": None} for s in sqls]

    rounds = []

    async def on_round(n, pending):
        rounds.append((n, pending))

    out = await run_all({"a": _gen("a", 2), "b": _gen("b", 1)}, execute, on_round)
    assert batches == [("dev", ["a-dev-0", "b-dev-0"]), ("prod", ["a-prod-0", "b-prod-0"]), ("dev", ["a-dev-1"])]
    assert rounds == [(1, 2), (2, 1)]
    assert out["a"]["seen"][1] == {"dev": [{"columns": [], "rows": [["a-dev-1"]], "error": None}], "prod": []}
    assert out["b"]["name"] == "b"


# ── filter ────────────────────────────────────────────────────────────────────


def test_plain_sql_condition():
    check_sql_condition("order_date >= '2026-01-01' and status <> 'x'", "duckdb")
    for bad in ("1 = 1; drop table x", "id in (select id from t)", "{{ ref('x') }} = 1", "a -- b"):
        with pytest.raises(QueryInvalid):
            check_sql_condition(bad, "duckdb")
