"""Following a generic test across a YAML edit that renames it (app/dbt/test_rename.py)."""

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from app.dbt import test_rename
from app.dbt.runner import runner


def _test(name: str, *, model: str = "model.p.orders", kind: str = "accepted_values",
          column: str | None = "status", path: str = "models/schema.yml") -> dict:
    return {
        "resource_type": "test",
        "name": name,
        "attached_node": model,
        "column_name": column,
        "original_file_path": path,
        "test_metadata": {"name": kind, "namespace": None, "kwargs": {}},
    }


def _manifest(*tests: dict) -> dict:
    nodes = {f"test.p.{t['name']}.abc": t for t in tests}
    nodes["model.p.orders"] = {"resource_type": "model", "name": "orders"}
    return {"nodes": nodes}


OLD = _manifest(_test("accepted_values_orders_status__a__b"), _test("not_null_orders_id", kind="not_null", column="id"))
NEW = _manifest(_test("accepted_values_orders_status__a__b__c"), _test("not_null_orders_id", kind="not_null", column="id"))


def test_identity_only_for_generic_tests():
    assert test_rename.test_identity(OLD, "not_null_orders_id") is not None
    assert test_rename.test_identity(OLD, "orders") is None  # a model
    assert test_rename.test_identity(OLD, "missing") is None
    singular = _manifest({"resource_type": "test", "name": "assert_x", "original_file_path": "tests/assert_x.sql"})
    assert test_rename.test_identity(singular, "assert_x") is None


def test_renamed_follows_the_matching_test():
    ident = test_rename.test_identity(OLD, "accepted_values_orders_status__a__b")
    assert test_rename.renamed_test(OLD, NEW, "accepted_values_orders_status__a__b", ident) == (
        "accepted_values_orders_status__a__b__c"
    )


def test_renamed_keeps_a_name_that_still_exists():
    ident = test_rename.test_identity(OLD, "not_null_orders_id")
    assert test_rename.renamed_test(OLD, NEW, "not_null_orders_id", ident) == "not_null_orders_id"


def test_renamed_prefers_the_new_test_when_another_matches():
    # two accepted_values tests on the same column: the untouched one keeps its name
    old = _manifest(_test("av_one"), _test("av_two"))
    new = _manifest(_test("av_one_renamed"), _test("av_two"))
    ident = test_rename.test_identity(old, "av_one")
    assert test_rename.renamed_test(old, new, "av_one", ident) == "av_one_renamed"


def test_renamed_is_none_when_ambiguous_or_gone():
    ident = test_rename.test_identity(OLD, "accepted_values_orders_status__a__b")
    gone = _manifest(_test("not_null_orders_id", kind="not_null", column="id"))
    assert test_rename.renamed_test(OLD, gone, "accepted_values_orders_status__a__b", ident) is None
    two_new = _manifest(_test("av_x"), _test("av_y"))
    assert test_rename.renamed_test(OLD, two_new, "accepted_values_orders_status__a__b", ident) is None


def _write_project(tmp_path: Path, manifest: dict, *, yaml_newer: bool) -> Path:
    (tmp_path / "target").mkdir()
    (tmp_path / "models").mkdir()
    mpath = tmp_path / "target" / "manifest.json"
    mpath.write_text(json.dumps(manifest))
    yml = tmp_path / "models" / "schema.yml"
    yml.write_text("version: 2\n")
    base = mpath.stat().st_mtime
    os.utime(yml, (base + 10, base + 10) if yaml_newer else (base - 10, base - 10))
    return tmp_path


def test_yaml_newer_than_ignores_target_and_packages(tmp_path):
    project = _write_project(tmp_path, OLD, yaml_newer=False)
    mtime = (project / "target" / "manifest.json").stat().st_mtime
    assert not test_rename.yaml_newer_than(project, mtime)
    pkg = project / "dbt_packages" / "x"
    pkg.mkdir(parents=True)
    (pkg / "schema.yml").write_text("")
    os.utime(pkg / "schema.yml", (mtime + 10, mtime + 10))
    assert not test_rename.yaml_newer_than(project, mtime)
    os.utime(project / "models" / "schema.yml", (mtime + 10, mtime + 10))
    assert test_rename.yaml_newer_than(project, mtime)


@pytest.mark.asyncio
async def test_resolve_parses_and_returns_the_new_name(tmp_path):
    project = _write_project(tmp_path, OLD, yaml_newer=True)

    async def fake_run(req, **_):
        assert req.command == "parse"
        (project / "target" / "manifest.json").write_text(json.dumps(NEW))
        return 0, b"", b""

    with patch.object(runner, "run", side_effect=fake_run) as run:
        name = await test_rename.resolve_test_name(1, project, "accepted_values_orders_status__a__b", None, "dev")
    assert name == "accepted_values_orders_status__a__b__c"
    assert run.call_args.args[0].extra == ("--target", "dev")


@pytest.mark.asyncio
async def test_resolve_skips_parse_when_manifest_is_fresh(tmp_path):
    project = _write_project(tmp_path, OLD, yaml_newer=False)
    with patch.object(runner, "run") as run:
        name = await test_rename.resolve_test_name(1, project, "accepted_values_orders_status__a__b", None, None)
    assert name == "accepted_values_orders_status__a__b"
    run.assert_not_called()


@pytest.mark.asyncio
async def test_resolve_skips_parse_for_models_and_keeps_name_on_parse_failure(tmp_path):
    project = _write_project(tmp_path, OLD, yaml_newer=True)
    with patch.object(runner, "run") as run:
        assert await test_rename.resolve_test_name(1, project, "orders", None, None) == "orders"
    run.assert_not_called()

    async def failing(req, **_):
        return 2, b"", b"Parsing Error"

    with patch.object(runner, "run", side_effect=failing):
        name = await test_rename.resolve_test_name(1, project, "accepted_values_orders_status__a__b", None, None)
    assert name == "accepted_values_orders_status__a__b"


@pytest.mark.asyncio
async def test_resolve_selector_keeps_graph_operators_and_skips_complex_selectors(tmp_path):
    project = _write_project(tmp_path, OLD, yaml_newer=True)

    async def fake_run(req, **_):
        (project / "target" / "manifest.json").write_text(json.dumps(NEW))
        return 0, b"", b""

    with patch.object(runner, "run", side_effect=fake_run):
        sel = await test_rename.resolve_test_selector(1, project, "+accepted_values_orders_status__a__b", None, None)
    assert sel == "+accepted_values_orders_status__a__b__c"
    with patch.object(runner, "run") as run:
        assert await test_rename.resolve_test_selector(1, project, "tag:x orders", None, None) == "tag:x orders"
    run.assert_not_called()
