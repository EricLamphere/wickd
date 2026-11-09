"""Unit tests (plan 19): result persistence, graph DTO, generation proposals (Pro,
gated, generator stubbed), focus options, and re-baselining a failing test (Base)."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.api.runs as runs_module
from app.ai.documentation import FileChange
from app.api import ai_proposal_apply, ai_proposals
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, InvocationModelResult, ModelStatus, Project, RunInvocation
from app.licensing import entitlements
from app.main import app
from app.unit_tests import pro as unit_pro
from app.unit_tests.context import UnitTestError
from app.unit_tests.generation import UnitTestResult

UID = "model.proj.orders"
UT_UID = "unit_test.proj.orders.orders_state"
DIFF_MESSAGE = (
    "\n\nactual differs from expected:\n\n@@ ,id,state\r\n   ,1 ,done\r\n→  ,2 ,open→back\r\n+++,3 ,done\r\n\n"
)
SCHEMA = """version: 2
models:
  - name: orders
unit_tests:
  - name: orders_state
    model: orders
    given:
      - input: ref('raw_orders')
        rows:
          - {id: 1}
    expect:
      rows:
        - {id: 1, state: done}
        - {id: 2, state: open}
"""


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'ut.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with sessions() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", sessions)
    monkeypatch.setattr(runs_module, "SessionLocal", sessions)
    yield sessions
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


def _entitle(monkeypatch: pytest.MonkeyPatch, entitled: bool = True) -> None:
    async def _check(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=entitled, reason="granted" if entitled else "not_licensed")

    monkeypatch.setattr(entitlements, "check_entitlement", _check)


@pytest.fixture
def entitled(monkeypatch):
    _entitle(monkeypatch)
    monkeypatch.setattr(unit_pro, "is_available", lambda: True)


@pytest.fixture
def after_accept(monkeypatch):
    mock = AsyncMock()
    monkeypatch.setattr(ai_proposals, "run_after_accept", mock)
    monkeypatch.setattr(ai_proposal_apply, "run_after_accept", mock)
    monkeypatch.setattr(ai_proposals, "load_project_env", AsyncMock(return_value={}))
    monkeypatch.setattr(ai_proposals, "_compile_model", AsyncMock())
    return mock


def _manifest(compiled: str | None = None) -> dict:
    return {
        "metadata": {"dbt_version": "1.10.13", "adapter_type": "duckdb"},
        "nodes": {
            UID: {
                "resource_type": "model", "name": "orders", "original_file_path": "models/orders.sql",
                "config": {"materialized": "table"}, "depends_on": {"nodes": ["seed.proj.raw_orders"]},
                "relation_name": '"db"."main"."orders"', **({"compiled_code": compiled} if compiled else {}),
            },
            "seed.proj.raw_orders": {
                "resource_type": "seed", "name": "raw_orders", "relation_name": '"db"."main"."raw_orders"',
                "columns": {"id": {}, "status": {}},
            },
        },
        "sources": {},
        "unit_tests": {
            UT_UID: {
                "name": "orders_state", "model": "orders", "original_file_path": "models/schema.yml",
                "depends_on": {"nodes": [UID]},
                "given": [{"input": "ref('raw_orders')", "rows": [{"id": 1}], "format": "dict"}],
                "expect": {"rows": [{"id": 1, "state": "done"}, {"id": 2, "state": "open"}], "format": "dict"},
            },
        },
        "parent_map": {UID: ["seed.proj.raw_orders"]},
    }


async def _project(db, tmp_path: Path, manifest: dict | None = None) -> Project:
    root = tmp_path / "proj"
    (root / "models").mkdir(parents=True)
    (root / "target").mkdir()
    (root / "models" / "schema.yml").write_text(SCHEMA)
    (root / "target" / "manifest.json").write_text(json.dumps(manifest or _manifest()))
    async with db() as session:
        project = Project(name="proj", path=str(root), platform="duckdb")
        session.add(project)
        await session.commit()
        return project


async def _wait(client: AsyncClient, pid: int, proposal_id: int, status: str) -> dict:
    for _ in range(100):
        body = (await client.get(f"/api/projects/{pid}/ai/proposals/{proposal_id}")).json()
        if body["status"] == status:
            return body
        await asyncio.sleep(0.02)
    raise AssertionError(f"proposal never reached {status}: {body}")


# ── Phase 1: persistence + graph ─────────────────────────────────────────────


def test_result_kind():
    assert runs_module.result_kind("test.proj.not_null_x.abc") == "test"
    assert runs_module.result_kind(UT_UID) == "unit_test"
    assert runs_module.result_kind(UID) == "model"


async def test_persist_unit_test_kind_and_parent(db, tmp_path):
    project = await _project(db, tmp_path)
    async with db() as session:
        session.add(ModelStatus(project_id=project.id, unique_id=UT_UID, kind="model", status="idle"))
        inv = RunInvocation(project_id=project.id, command="test", status="running")
        session.add(inv)
        await session.commit()
        inv_id = inv.id
    (Path(project.path) / "target" / "run_results.json").write_text(json.dumps({"results": [
        {"unique_id": UT_UID, "status": "fail", "message": DIFF_MESSAGE, "execution_time": 0.1, "timing": []},
    ]}))
    await runs_module._persist_results_after_run(project, inv_id)
    async with db() as session:
        row = (await session.execute(select(ModelStatus).where(ModelStatus.unique_id == UT_UID))).scalar_one()
        assert (row.kind, row.parent_model_id, row.status) == ("unit_test", UID, "error")
        hist = (await session.execute(select(InvocationModelResult))).scalar_one()
        assert (hist.kind, hist.name) == ("unit_test", "orders_state")


async def test_graph_returns_unit_test_status_and_diff(client, db, tmp_path):
    project = await _project(db, tmp_path)
    async with db() as session:
        session.add(ModelStatus(project_id=project.id, unique_id=UT_UID, kind="unit_test",
                                parent_model_id=UID, status="fail", message=DIFF_MESSAGE))
        await session.commit()
    body = (await client.get(f"/api/projects/{project.id}/models")).json()
    unit = body["unit_tests"][0]
    assert unit["status"] == "fail" and unit["model_unique_id"] == UID
    assert unit["inputs"] == ["ref('raw_orders')"] and unit["expect_rows"] == 2
    assert unit["diff"]["columns"] == ["id", "state"]
    assert [r["status"] for r in unit["diff"]["rows"]] == ["same", "changed", "added"]


# ── generation (Pro) ─────────────────────────────────────────────────────────


async def test_generate_requires_pro(client, db, tmp_path, monkeypatch):
    _entitle(monkeypatch, entitled=False)
    project = await _project(db, tmp_path)
    r = await client.post(f"/api/projects/{project.id}/ai/unit-tests", json={"unique_id": UID})
    assert r.status_code == 403


async def test_generate_503_without_engine(client, db, tmp_path, monkeypatch):
    _entitle(monkeypatch)
    monkeypatch.setattr(unit_pro, "is_available", lambda: False)
    project = await _project(db, tmp_path)
    r = await client.post(f"/api/projects/{project.id}/ai/unit-tests", json={"unique_id": UID})
    assert r.status_code == 503


async def test_generate_rejects_bad_focus(client, db, tmp_path, entitled):
    project = await _project(db, tmp_path)
    r = await client.post(f"/api/projects/{project.id}/ai/unit-tests", json={"unique_id": UID, "focus": "rm -rf"})
    assert r.status_code == 422


async def test_generate_lifecycle_and_accept_runs_test(client, db, tmp_path, entitled, after_accept, monkeypatch):
    project = await _project(db, tmp_path)
    seen: dict = {}

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        await kwargs["on_phase"]("sampling")
        return UnitTestResult(
            change=FileChange("models/schema.yml", SCHEMA, SCHEMA + "  - name: orders_logic\n"),
            summary={"unit_test": {"name": "orders_logic", "model": "orders", "file": "models/schema.yml"},
                     "fixtures": [], "expected": {"columns": [], "rows": []}},
        )

    monkeypatch.setattr(ai_proposals, "generate_unit_test", fake_generate)
    r = await client.post(f"/api/projects/{project.id}/ai/unit-tests",
                          json={"unique_id": UID, "focus": "case:state", "mask": True})
    assert r.status_code == 202
    assert r.json()["title"] == "Unit test for orders (state)"
    body = await _wait(client, project.id, r.json()["id"], "ready")
    assert seen["focus"] == "case:state" and seen["mask"] is True and seen["file"] is None
    assert body["kind"] == "unit_test" and body["result"]["unit_test"]["name"] == "orders_logic"

    file_id = body["files"][0]["id"]
    r = await client.post(f"/api/projects/{project.id}/ai/proposals/{body['id']}/files/{file_id}/accept")
    assert r.status_code == 200 and r.json()["status"] == "applied"
    assert (Path(project.path) / "models" / "schema.yml").read_text().endswith("orders_logic\n")
    after_accept.assert_awaited_once()
    assert after_accept.await_args.args[1]["unit_test"]["name"] == "orders_logic"


async def test_generate_error_is_reported(client, db, tmp_path, entitled, after_accept, monkeypatch):
    project = await _project(db, tmp_path)

    async def failing(**kwargs):
        raise UnitTestError("dbt can't unit test ephemeral models")

    monkeypatch.setattr(ai_proposals, "generate_unit_test", failing)
    r = await client.post(f"/api/projects/{project.id}/ai/unit-tests", json={"unique_id": UID})
    body = await _wait(client, project.id, r.json()["id"], "error")
    assert "ephemeral" in body["error_message"]


async def test_focus_options(client, db, tmp_path, entitled, monkeypatch):
    from app.api import unit_tests as unit_tests_api

    project = await _project(db, tmp_path)

    async def cant_compile(*args):
        raise UnitTestError("compiling orders failed")

    monkeypatch.setattr(unit_tests_api, "compile_model", cant_compile)
    monkeypatch.setattr(unit_tests_api, "load_project_env", AsyncMock(return_value={}))
    r = await client.get(f"/api/projects/{project.id}/unit-tests/focus-options", params={"unique_id": UID})
    assert r.json() == {"options": [], "compiled": False}

    (Path(project.path) / "target" / "manifest.json").write_text(
        json.dumps(_manifest(compiled='select id from "db"."main"."raw_orders"'))
    )
    calls = []

    def fake(sql, adapter, inputs):
        calls.append((adapter, inputs))
        return [{"id": "case:state", "label": "CASE → state", "kind": "case"}]

    monkeypatch.setattr(unit_pro, "focus_options", fake)
    r = await client.get(f"/api/projects/{project.id}/unit-tests/focus-options", params={"unique_id": UID})
    assert r.json()["compiled"] and r.json()["options"][0]["id"] == "case:state"
    assert calls[0][0] == "duckdb"
    assert calls[0][1] == [{"key": "ref('raw_orders')", "relation": '"db"."main"."raw_orders"', "columns": ["id", "status"]}]


async def test_focus_options_rejects_non_models(client, db, tmp_path, entitled):
    project = await _project(db, tmp_path)
    r = await client.get(f"/api/projects/{project.id}/unit-tests/focus-options",
                         params={"unique_id": "seed.proj.raw_orders"})
    assert r.status_code == 422


# ── rebaseline (Base) ────────────────────────────────────────────────────────


async def test_rebaseline_proposal_and_accept(client, db, tmp_path, after_accept, monkeypatch):
    _entitle(monkeypatch, entitled=False)  # Base: no Pro needed
    project = await _project(db, tmp_path)
    async with db() as session:
        session.add(ModelStatus(project_id=project.id, unique_id=UT_UID, kind="unit_test",
                                parent_model_id=UID, status="fail", message=DIFF_MESSAGE))
        await session.commit()
    r = await client.post(f"/api/projects/{project.id}/unit-tests/{UT_UID}/rebaseline")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "unit_test_rebaseline" and body["status"] == "ready"
    assert body["result"]["actual"]["rows"] == [[1, "done"], [2, "back"], [3, "done"]]

    file_id = body["files"][0]["id"]
    r = await client.post(f"/api/projects/{project.id}/ai/proposals/{body['id']}/files/{file_id}/accept")
    assert r.status_code == 200, r.text
    text = (Path(project.path) / "models" / "schema.yml").read_text()
    assert "- {id: 2, state: back}" in text and "- {id: 3, state: done}" in text
    after_accept.assert_awaited_once()


async def test_rebaseline_without_diff(client, db, tmp_path):
    project = await _project(db, tmp_path)
    r = await client.post(f"/api/projects/{project.id}/unit-tests/{UT_UID}/rebaseline")
    assert r.status_code == 409
    r = await client.post(f"/api/projects/{project.id}/unit-tests/unit_test.proj.orders.nope/rebaseline")
    assert r.status_code == 404


async def test_generate_with_chosen_file(client, db, tmp_path, entitled, after_accept, monkeypatch):
    project = await _project(db, tmp_path)
    seen: dict = {}

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        raise UnitTestError("stop here")

    monkeypatch.setattr(ai_proposals, "generate_unit_test", fake_generate)
    r = await client.post(f"/api/projects/{project.id}/ai/unit-tests", json={"unique_id": UID, "file": "checks"})
    assert r.status_code == 202
    await _wait(client, project.id, r.json()["id"], "error")
    assert seen["file"] == "models/checks.yml"
    r = await client.post(f"/api/projects/{project.id}/ai/unit-tests", json={"unique_id": UID, "file": "../x.yml"})
    assert r.status_code == 422


async def test_file_options_route(client, db, tmp_path, entitled):
    project = await _project(db, tmp_path)
    body = (await client.get(f"/api/projects/{project.id}/unit-tests/file-options", params={"unique_id": UID})).json()
    assert body == {"default": "models/schema.yml", "existing": ["models/schema.yml"],
                    "files": ["models/schema.yml"], "model_dir": "models"}


async def test_focus_options_fall_back_to_compiled_file_then_compile(client, db, tmp_path, entitled, monkeypatch):
    from app.api import unit_tests as unit_tests_api

    manifest = _manifest()
    manifest["nodes"][UID]["package_name"] = "proj"
    project = await _project(db, tmp_path, manifest)
    seen: list[str] = []

    def fake_focus(sql, adapter, inputs):
        seen.append(sql)
        return [{"id": "cte:a", "label": "CTE a", "kind": "cte"}]

    async def compile_model(project_id, project_path, name, env, full_refresh):
        return "select 2"

    monkeypatch.setattr(unit_pro, "focus_options", fake_focus)
    monkeypatch.setattr(unit_tests_api, "compile_model", compile_model)
    monkeypatch.setattr(unit_tests_api, "load_project_env", AsyncMock(return_value={}))
    url = f"/api/projects/{project.id}/unit-tests/focus-options"

    r = await client.get(url, params={"unique_id": UID})  # nothing on disk: compiled now
    assert r.json()["compiled"] and seen[-1] == "select 2"

    compiled = Path(project.path) / "target" / "compiled" / "proj" / "models" / "orders.sql"
    compiled.parent.mkdir(parents=True)
    compiled.write_text("select 1")
    r = await client.get(url, params={"unique_id": UID})
    assert r.json()["options"][0]["id"] == "cte:a" and seen[-1] == "select 1"
