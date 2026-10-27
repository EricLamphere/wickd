"""Refactor routes: gating, building a multi-file proposal (rename / create ops), Accept all,
conflicts, `dbt parse` after applying, Undo, and the Wicky confirm-card flow. The Pro
engine is faked (app.refactor.pro._pro); dbt is faked (verify._parse)."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.ai import pro as ai_pro
from app.api import refactor as refactor_api
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project
from app.licensing import entitlements
from app.main import app
from app.refactor import pro, verify

STG = "model.proj.stg_customers"
STG_SQL = "select id as customer_id from raw\n"
MART_SQL = "select * from {{ ref('stg_customers') }}\n"
MANIFEST = {
    "metadata": {"project_name": "proj"},
    "nodes": {
        STG: {"name": "stg_customers", "resource_type": "model", "package_name": "proj",
              "original_file_path": "models/stg_customers.sql", "depends_on": {"nodes": []}},
        "model.proj.mart": {"name": "mart", "resource_type": "model", "package_name": "proj",
                            "original_file_path": "models/mart.sql", "depends_on": {"nodes": [STG]}},
    },
}


def _fake_engine(calls: dict) -> SimpleNamespace:
    def rename_model(manifest, files, unique_id, new_name):
        calls["rename_model"] = {"files": sorted(files), "unique_id": unique_id, "new_name": new_name}
        if new_name == "mart":
            raise ValueError("`mart` is already used by model.proj.mart")
        return {
            "changes": [
                {"op": "rename", "path": "models/stg_customers.sql", "new_path": f"models/{new_name}.sql",
                 "original": STG_SQL, "proposed": STG_SQL},
                {"op": "modify", "path": "models/mart.sql", "original": MART_SQL,
                 "proposed": MART_SQL.replace("stg_customers", new_name)},
            ],
            "manual": [{"path": "dbt_project.yml", "line": 3, "text": "stg_customers:", "reason": "config key"}],
            "notes": ["old relation stays"],
            "summary": {"op": "rename_model", "files": 2},
        }

    def rename_column(manifest, files, lineage, unique_id, column, new_name):
        calls["rename_column"] = {"lineage": lineage, "column": column}
        return {"changes": [], "manual": [], "notes": [], "summary": {"op": "rename_column"}}

    def extract_cte(manifest, files, unique_id, cte, new_name):
        return {
            "changes": [{"op": "create", "path": f"models/{new_name}.sql", "original": None, "proposed": "select 1 as x\n"}],
            "manual": [], "notes": [],
            "summary": {"op": "extract_cte", "new": new_name, "new_path": f"models/{new_name}.sql", "columns": ["x"]},
        }

    return SimpleNamespace(rename_model=rename_model, rename_column=rename_column, extract_cte=extract_cte)


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'r.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with sessions() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", sessions)
    async with sessions() as session:
        yield session
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


def _entitle(monkeypatch: pytest.MonkeyPatch, entitled: bool = True) -> None:
    async def _check(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=entitled, reason="granted" if entitled else "not_licensed")

    monkeypatch.setattr(entitlements, "check_entitlement", _check)


@pytest.fixture
def calls(monkeypatch) -> dict:
    recorded: dict = {}
    monkeypatch.setattr(pro, "_pro", lambda: _fake_engine(recorded))
    _entitle(monkeypatch)
    return recorded


@pytest.fixture
def parsed(monkeypatch) -> list:
    """Fakes `dbt parse`; append a dict to change its outcome."""
    outcomes: list = []

    async def _parse(project_id, project_path):
        outcomes.append(project_path)
        return {"status": "ok", "output": "Performance info: target/perf_info.json"}

    monkeypatch.setattr(verify, "_parse", _parse)
    return outcomes


async def _project(session: AsyncSession, tmp_path: Path) -> tuple[int, Path]:
    root = tmp_path / "proj"
    (root / "models").mkdir(parents=True)
    (root / "target").mkdir()
    (root / "target" / "manifest.json").write_text(json.dumps(MANIFEST))
    (root / "dbt_project.yml").write_text("name: proj\n")
    (root / "models" / "stg_customers.sql").write_text(STG_SQL)
    (root / "models" / "mart.sql").write_text(MART_SQL)
    project = Project(name="proj", path=str(root), platform="local")
    session.add(project)
    await session.commit()
    return project.id, root


async def _wait(client: AsyncClient, pid: int, proposal_id: int, check) -> dict:
    for _ in range(100):
        body = (await client.get(f"/api/projects/{pid}/ai/proposals/{proposal_id}")).json()
        if check(body):
            return body
        await asyncio.sleep(0.02)
    raise AssertionError(f"proposal never got there: {body}")


async def _ready(client: AsyncClient, pid: int, body: dict) -> dict:
    r = await client.post(f"/api/projects/{pid}/refactor", json=body)
    assert r.status_code == 202, r.text
    return await _wait(client, pid, r.json()["id"], lambda p: p["status"] != "generating")


RENAME = {"op": "rename_model", "unique_id": STG, "new_name": "stg_clients"}


# ── gating ───────────────────────────────────────────────────────────────────


async def test_refactor_requires_pro(client, db_session, tmp_path, monkeypatch):
    _entitle(monkeypatch, entitled=False)
    pid, _ = await _project(db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/refactor", json=RENAME)
    assert r.status_code == 403 and r.json()["detail"]["error"] == "pro_feature_required"


async def test_refactor_503_without_engine(client, db_session, tmp_path, monkeypatch):
    _entitle(monkeypatch)
    monkeypatch.setattr(pro, "is_available", lambda: False)
    pid, _ = await _project(db_session, tmp_path)
    assert (await client.post(f"/api/projects/{pid}/refactor", json=RENAME)).status_code == 503


async def test_refactor_needs_no_ai_model(client, db_session, calls, parsed, tmp_path, monkeypatch):
    monkeypatch.setattr(ai_pro, "is_available", lambda: False)  # no AI package: direct refactors still work
    pid, _ = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, RENAME)
    assert proposal["status"] == "ready"


@pytest.mark.parametrize("body", [
    {"op": "rename_column", "unique_id": STG, "new_name": "x"},
    {"op": "extract_cte", "unique_id": STG, "new_name": "x"},
    {"op": "drop_table", "unique_id": STG, "new_name": "x"},
])
async def test_refactor_validates_the_operation(client, db_session, calls, tmp_path, body):
    pid, _ = await _project(db_session, tmp_path)
    assert (await client.post(f"/api/projects/{pid}/refactor", json=body)).status_code == 422


# ── building, applying, undoing ──────────────────────────────────────────────


async def test_rename_builds_file_ops_and_manual_list(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, RENAME)
    assert proposal["kind"] == "refactor" and proposal["title"] == "Rename model `stg_customers` → `stg_clients`"
    ops = {f["path"]: (f["op"], f["new_path"]) for f in proposal["files"]}
    assert ops == {
        "models/stg_customers.sql": ("rename", "models/stg_clients.sql"),
        "models/mart.sql": ("modify", None),
    }
    assert proposal["result"]["manual"][0]["reason"] == "config key"
    assert proposal["result"]["notes"] == ["old relation stays"]
    assert proposal["result"]["summary"]["op"] == "rename_model"
    assert "models/mart.sql" in calls["rename_model"]["files"]


async def test_engine_refusal_is_an_error_with_the_reason(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, {**RENAME, "new_name": "mart"})
    assert proposal["status"] == "error"
    assert proposal["error_message"] == "`mart` is already used by model.proj.mart"


async def test_accept_all_applies_parses_and_undo_restores(client, db_session, calls, parsed, tmp_path):
    pid, root = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, RENAME)

    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/accept")
    assert r.status_code == 200 and r.json()["status"] == "applied"
    assert not (root / "models" / "stg_customers.sql").exists()
    assert (root / "models" / "stg_clients.sql").read_text() == STG_SQL
    assert "ref('stg_clients')" in (root / "models" / "mart.sql").read_text()
    verified = await _wait(client, pid, proposal["id"], lambda p: (p["result"]["verify"] or {}).get("status") == "ok")
    assert parsed == [root]
    assert "perf_info" in verified["result"]["verify"]["output"]

    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/undo")
    assert r.status_code == 200 and r.json()["status"] == "undone"
    assert (root / "models" / "stg_customers.sql").read_text() == STG_SQL
    assert not (root / "models" / "stg_clients.sql").exists()
    assert (root / "models" / "mart.sql").read_text() == MART_SQL
    assert {f["status"] for f in r.json()["files"]} == {"undone"}


async def test_accept_all_writes_nothing_on_conflict(client, db_session, calls, parsed, tmp_path):
    pid, root = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, RENAME)
    (root / "models" / "mart.sql").write_text("edited meanwhile")
    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/accept")
    assert r.status_code == 409
    assert r.json()["detail"]["files"] == ["models/mart.sql changed since this was generated — regenerate to review it again"]
    assert (root / "models" / "stg_customers.sql").exists()  # the rename wasn't applied either
    assert parsed == []


async def test_undo_refused_when_a_file_changed_since(client, db_session, calls, parsed, tmp_path):
    pid, root = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, RENAME)
    await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/accept")
    (root / "models" / "mart.sql").write_text("edited after")
    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/undo")
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "changed_since_applied", "files": ["models/mart.sql changed since it was applied"]}
    assert (root / "models" / "stg_clients.sql").exists()  # nothing was undone


async def test_per_file_accept_parses_once_everything_is_decided(client, db_session, calls, parsed, tmp_path):
    pid, root = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, RENAME)
    rename, modify = proposal["files"][0], proposal["files"][1]
    await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{rename['id']}/accept")
    assert parsed == []
    await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{modify['id']}/reject")
    await _wait(client, pid, proposal["id"], lambda p: (p["result"]["verify"] or {}).get("status") == "ok")
    assert (root / "models" / "mart.sql").read_text() == MART_SQL


async def test_parse_failure_is_reported_not_reverted(client, db_session, calls, tmp_path, monkeypatch):
    async def _fail(project_id, project_path):
        return {"status": "error", "output": "Compilation Error: model 'stg_customers' was not found"}

    monkeypatch.setattr(verify, "_parse", _fail)
    pid, root = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, RENAME)
    await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/accept")
    done = await _wait(client, pid, proposal["id"], lambda p: (p["result"]["verify"] or {}).get("status") == "error")
    assert done["status"] == "applied" and (root / "models" / "stg_clients.sql").exists()


async def test_extract_adds_a_yaml_stub(client, db_session, calls, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    proposal = await _ready(client, pid, {"op": "extract_cte", "unique_id": STG, "cte": "base", "new_name": "base_x"})
    files = {f["path"]: f for f in proposal["files"]}
    assert files["models/base_x.sql"]["op"] == "create"
    stub = files["models/schema.yml"]
    assert stub["op"] == "create" and "- name: base_x" in stub["proposed_text"] and "- name: x" in stub["proposed_text"]


async def test_rename_column_gets_the_latest_lineage(client, db_session, calls, tmp_path):
    from app.db.models import ColumnLineageSnapshot

    pid, _ = await _project(db_session, tmp_path)
    db_session.add(ColumnLineageSnapshot(
        project_id=pid, status="done", results_json=json.dumps({STG: {"customer_id": []}}),
        row_dependencies_json="{}", lineage_version=3,
    ))
    await db_session.commit()
    proposal = await _ready(client, pid, {"op": "rename_column", "unique_id": STG, "column": "customer_id", "new_name": "k"})
    assert proposal["status"] == "empty"
    assert calls["rename_column"]["lineage"]["results"] == {STG: {"customer_id": []}}


# ── Wicky: request → confirm card → proposal ─────────────────────────────────


async def test_wicky_request_becomes_a_confirm_card_then_an_action(client, db_session, calls, tmp_path, monkeypatch):
    monkeypatch.setattr(ai_pro, "is_available", lambda: True)

    async def _llm(config, messages, schema, max_tokens):
        return "{}"

    async def _config(session):
        return None

    monkeypatch.setattr(refactor_api, "_write_sql", _llm)
    monkeypatch.setattr(refactor_api, "load_ai_config", _config)
    monkeypatch.setattr(ai_pro, "refactor_prompt", lambda *a: {"messages": [], "schema": {}, "max_tokens": 10})
    monkeypatch.setattr(ai_pro, "parse_refactor_intent", lambda raw, manifest, uid: {
        "op": "rename_model", "unique_id": STG, "model": "stg_customers", "new_name": "stg_clients",
    })
    pid, _ = await _project(db_session, tmp_path)
    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]

    r = await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/refactor",
                          json={"content": "rename stg_customers to stg_clients", "unique_id": STG})
    assert r.status_code == 200, r.text
    question, card = r.json()
    assert question["role"] == "user" and card["role"] == "refactor"
    assert card["payload"]["status"] == "proposed"
    assert card["payload"]["description"] == "Rename model `stg_customers` → `stg_clients` (1 downstream model)"

    r = await client.post(f"/api/projects/{pid}/refactor",
                          json={**RENAME, "conversation_id": cid, "message_id": card["id"]})
    assert r.status_code == 202
    detail = (await client.get(f"/api/projects/{pid}/ai/conversations/{cid}")).json()
    roles = [m["role"] for m in detail["messages"]]
    assert roles == ["user", "refactor", "action"]
    assert detail["messages"][1]["payload"]["status"] == "confirmed"
    assert detail["messages"][2]["proposal"]["kind"] == "refactor"


async def test_wicky_none_and_cancel(client, db_session, calls, tmp_path, monkeypatch):
    monkeypatch.setattr(ai_pro, "is_available", lambda: True)

    async def _llm(config, messages, schema, max_tokens):
        return "{}"

    async def _config(session):
        return None

    monkeypatch.setattr(refactor_api, "_write_sql", _llm)
    monkeypatch.setattr(refactor_api, "load_ai_config", _config)
    monkeypatch.setattr(ai_pro, "refactor_prompt", lambda *a: {"messages": [], "schema": {}, "max_tokens": 10})
    answers = iter([
        {"op": "none", "reason": "Splitting a model isn't supported yet."},
        {"op": "rename_model", "unique_id": STG, "model": "stg_customers", "new_name": "x"},
    ])
    monkeypatch.setattr(ai_pro, "parse_refactor_intent", lambda raw, manifest, uid: next(answers))
    pid, _ = await _project(db_session, tmp_path)
    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]
    url = f"/api/projects/{pid}/ai/conversations/{cid}/refactor"

    _, card = (await client.post(url, json={"content": "split it"})).json()
    assert card["payload"]["status"] == "none" and card["content"] == "Splitting a model isn't supported yet."

    _, card = (await client.post(url, json={"content": "rename to x"})).json()
    r = await client.post(f"/api/projects/{pid}/ai/messages/{card['id']}/refactor/cancel")
    assert r.json()["payload"]["status"] == "cancelled"
