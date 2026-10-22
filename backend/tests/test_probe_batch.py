import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.dbt import probe
from app.dbt.probe import (
    BATCH_MARKER,
    build_batch_probe_sql,
    parse_batch_probe_output,
    probe_many_warehouse_columns,
)
from app.dbt.runner import runner


def _marker_line(payload: dict) -> str:
    return f"{BATCH_MARKER}{json.dumps(payload)}"


def test_build_sql_refs_every_name_unguarded_and_reads_columns_only_at_execute():
    sql = build_batch_probe_sql(("orders", "customers"))
    # ref() runs outside `if execute` so dbt records the dependencies at parse time
    assert sql.index("ref(") < sql.index("{% if execute %}")
    assert "adapter.get_columns_in_relation" in sql
    assert "data_type" in sql
    assert '["orders", "customers"]' in sql
    assert BATCH_MARKER in sql


def test_build_sql_escapes_quotes_in_names():
    sql = build_batch_probe_sql(('we"ird',))
    assert '["we\\"ird"]' in sql


def test_parse_finds_marker_line_among_log_noise():
    text = "\n".join([
        "12:00:00  Running with dbt=1.9.0",
        _marker_line({"orders": [["id", "integer"], ["amount", "numeric(10,2)"]], "customers": []}),
        '{"show": [{"wickd_probe": 1}]}',
    ])
    assert parse_batch_probe_output(text) == {
        "orders": (("id", "integer"), ("amount", "numeric(10,2)")),
        "customers": (),
    }


def test_parse_accepts_marker_mid_line():
    text = "12:00:00  " + _marker_line({"orders": [["id", "integer"]]})
    assert parse_batch_probe_output(text) == {"orders": (("id", "integer"),)}


@pytest.mark.parametrize("text", [
    "", "no marker here", f"{BATCH_MARKER}not json", f"{BATCH_MARKER}[1, 2]",
    f'{BATCH_MARKER}{{"orders": ["id"]}}',  # entries must be [name, type] pairs
])
def test_parse_returns_none_without_valid_payload(text):
    assert parse_batch_probe_output(text) is None


async def test_probe_many_maps_columns_and_flags_empty_models(monkeypatch):
    out = _marker_line({"orders": [["id", "INTEGER"]], "missing": []}).encode()
    run = AsyncMock(return_value=(0, out, b""))
    monkeypatch.setattr(runner, "run", run)

    results = await probe_many_warehouse_columns(1, Path("/p"), ("orders", "missing"), {}, "dev")

    assert results is not None
    assert results["orders"].columns == ("id",) and results["orders"].error is None
    assert results["orders"].types == ("INTEGER",)
    assert results["missing"].columns == () and results["missing"].error
    req = run.await_args.args[0]
    assert req.command == "show"
    assert req.extra[-2:] == ("--target", "dev")


async def test_probe_many_reads_marker_from_stderr(monkeypatch):
    err = _marker_line({"orders": [["id", "integer"]]}).encode()
    monkeypatch.setattr(runner, "run", AsyncMock(return_value=(0, b"", err)))

    results = await probe_many_warehouse_columns(1, Path("/p"), ("orders",), {}, None)

    assert results is not None and results["orders"].columns == ("id",)


async def test_probe_many_returns_none_when_dbt_fails(monkeypatch):
    monkeypatch.setattr(runner, "run", AsyncMock(return_value=(1, b"", b"Compilation Error")))
    assert await probe_many_warehouse_columns(1, Path("/p"), ("orders",), {}, None) is None


async def test_probe_many_returns_none_when_a_model_is_missing_from_payload(monkeypatch):
    out = _marker_line({"orders": [["id", "integer"]]}).encode()
    monkeypatch.setattr(runner, "run", AsyncMock(return_value=(0, out, b"")))
    assert await probe_many_warehouse_columns(1, Path("/p"), ("orders", "other"), {}, None) is None


async def test_probe_many_returns_none_on_timeout(monkeypatch):
    async def _hang(_req):
        raise TimeoutError

    monkeypatch.setattr(runner, "run", _hang)
    assert await probe_many_warehouse_columns(1, Path("/p"), ("orders",), {}, None) is None


async def test_probe_many_with_no_names_skips_dbt(monkeypatch):
    run = AsyncMock()
    monkeypatch.setattr(runner, "run", run)
    assert await probe_many_warehouse_columns(1, Path("/p"), (), {}, None) == {}
    run.assert_not_awaited()


def test_batch_timeout_grows_with_batch_size():
    assert probe.batch_timeout_seconds(50) > probe.batch_timeout_seconds(1)


def test_build_sql_checks_the_relation_exists_before_reading_columns():
    sql = build_batch_probe_sql(("orders",))
    assert "load_relation(" in sql
    assert sql.index("load_relation(") < sql.index("get_columns_in_relation")


def test_parse_treats_null_as_not_built():
    text = _marker_line({"orders": [["id", "integer"]], "fresh": None})
    assert parse_batch_probe_output(text) == {"orders": (("id", "integer"),), "fresh": None}


async def test_probe_many_flags_relations_that_do_not_exist(monkeypatch):
    out = _marker_line({"orders": [["id", "integer"]], "fresh": None}).encode()
    monkeypatch.setattr(runner, "run", AsyncMock(return_value=(0, out, b"")))

    results = await probe_many_warehouse_columns(1, Path("/p"), ("orders", "fresh"), {}, None)

    assert results is not None
    assert not results["orders"].not_built
    assert results["fresh"].not_built
    assert results["fresh"].columns == () and results["fresh"].error == probe.NOT_BUILT_ERROR
