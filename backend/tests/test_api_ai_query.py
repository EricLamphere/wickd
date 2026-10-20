"""Query data routes: write SQL, run it behind the dbt lock, answer from results."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.ai import pro
from app.ai.client import Provider
from app.api import ai_chat, ai_query
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project
from app.dbt.runner import runner
from app.licensing import entitlements
from app.main import app

UID = "model.proj.orders"


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'q.sqlite'}", future=True)
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


@pytest.fixture(autouse=True)
def entitled(monkeypatch):
    async def _check(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=True, reason="granted")

    monkeypatch.setattr(entitlements, "check_entitlement", _check)
    monkeypatch.setattr(pro, "is_available", lambda: True)
    monkeypatch.setattr(ai_query, "load_project_env", AsyncMock(return_value={}))


@pytest.fixture
def model(monkeypatch):
    """The model's JSON answer for the SQL-writing step (set .answer)."""
    state = {"answer": json.dumps({"sql": "select status, count(*) as n from {{ ref('orders') }} group by 1",
                                   "explanation": "Orders per status."})}

    async def _write(config, messages, schema, max_tokens):
        return state["answer"]

    monkeypatch.setattr(pro, "query_prompt", lambda m, u, h, q: {"messages": [], "schema": {}, "max_tokens": 5})
    monkeypatch.setattr(pro, "parse_query", lambda raw: json.loads(raw))
    monkeypatch.setattr(ai_query, "_write_sql", _write)
    return state


async def _setup(client, session, tmp_path) -> tuple[int, int]:
    root = tmp_path / "proj"
    (root / "target").mkdir(parents=True)
    (root / "target" / "manifest.json").write_text(json.dumps({"metadata": {"adapter_type": "duckdb"}, "nodes": {}}))
    project = Project(name="proj", path=str(root), platform="local")
    session.add(project)
    await session.commit()
    cid = (await client.post(f"/api/projects/{project.id}/ai/conversations")).json()["id"]
    return project.id, cid


async def _wait(client, pid, cid, status) -> dict:
    for _ in range(100):
        msgs = (await client.get(f"/api/projects/{pid}/ai/conversations/{cid}")).json()["messages"]
        query = next(m for m in msgs if m["role"] == "query")
        if query["payload"]["status"] == status:
            return query
        await asyncio.sleep(0.02)
    raise AssertionError(f"query never reached {status}: {query['payload']}")


async def test_write_query_saves_question_and_sql(client, db_session, tmp_path, model):
    pid, cid = await _setup(client, db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/query", json={"content": "Orders by status?"})
    assert r.status_code == 200
    question, query = r.json()
    assert question["role"] == "user" and question["content"] == "Orders by status?"
    assert query["role"] == "query" and query["content"] == "Orders per status."
    assert query["payload"]["status"] == "proposed"
    assert "{{ ref('orders') }}" in query["payload"]["sql"]


async def test_unsafe_sql_is_marked_invalid(client, db_session, tmp_path, model):
    pid, cid = await _setup(client, db_session, tmp_path)
    model["answer"] = json.dumps({"sql": "delete from {{ ref('orders') }}", "explanation": "x"})
    _, query = (await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/query", json={"content": "q"})).json()
    assert query["payload"]["status"] == "invalid"
    assert "SELECT" in query["payload"]["error"]
    r = await client.post(f"/api/projects/{pid}/ai/messages/{query['id']}/run", json={"sql": "delete from x"})
    assert r.status_code == 422


async def test_run_then_answer(client, db_session, tmp_path, model, monkeypatch):
    pid, cid = await _setup(client, db_session, tmp_path)
    _, query = (await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/query", json={"content": "q"})).json()
    calls = []

    async def _run(req):
        calls.append(req)
        rows = [{"status": "placed", "n": 3}, {"status": "shipped", "n": 1}]
        return 0, json.dumps({"show": rows}).encode(), b""

    monkeypatch.setattr(runner, "run", _run)
    edited = "select status, count(*) as n from {{ ref('orders') }} group by 1 order by 2 desc;"
    r = await client.post(f"/api/projects/{pid}/ai/messages/{query['id']}/run", json={"sql": edited})
    assert r.status_code == 202 and r.json()["payload"]["status"] == "running"
    done = await _wait(client, pid, cid, "done")
    assert done["payload"]["columns"] == ["status", "n"]
    assert done["payload"]["rows"] == [["placed", 3], ["shipped", 1]]
    assert done["payload"]["sql"].endswith("desc")  # the edited SQL, semicolon stripped
    extra = calls[0].extra
    assert extra[extra.index("--limit") + 1] == "101" and calls[0].command == "show"

    captured = {}

    def _answer_msgs(question, sql, columns, rows, truncated):
        captured.update(question=question, rows=rows, truncated=truncated)
        return []

    async def _stream(provider, messages, max_tokens=None):
        yield "Mostly placed."

    monkeypatch.setattr(pro, "answer_messages", _answer_msgs)
    monkeypatch.setattr(ai_chat, "resolve_provider", AsyncMock(return_value=Provider("http://x/v1", "m")))
    monkeypatch.setattr(ai_chat, "stream_chat", _stream)
    r = await client.post(f"/api/projects/{pid}/ai/messages/{query['id']}/answer")
    assert "Mostly placed." in r.text
    assert captured == {"question": "q", "rows": [["placed", 3], ["shipped", 1]], "truncated": False}
    roles = [m["role"] for m in (await client.get(f"/api/projects/{pid}/ai/conversations/{cid}")).json()["messages"]]
    assert roles == ["user", "query", "assistant"]


async def test_dbt_error_is_recorded(client, db_session, tmp_path, model, monkeypatch):
    pid, cid = await _setup(client, db_session, tmp_path)
    _, query = (await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/query", json={"content": "q"})).json()
    monkeypatch.setattr(runner, "run", AsyncMock(return_value=(1, b"", b"Binder Error: column nope not found")))
    await client.post(f"/api/projects/{pid}/ai/messages/{query['id']}/run", json={"sql": query["payload"]["sql"]})
    failed = await _wait(client, pid, cid, "error")
    assert "Binder Error" in failed["payload"]["error"]
    # can be fixed and run again
    r = await client.post(f"/api/projects/{pid}/ai/messages/{query['id']}/run", json={"sql": "select 1 as a"})
    assert r.status_code == 202


async def test_waits_for_running_dbt_command(client, db_session, tmp_path, model, monkeypatch):
    pid, cid = await _setup(client, db_session, tmp_path)
    _, query = (await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/query", json={"content": "q"})).json()
    monkeypatch.setattr(ai_query, "LOCK_POLL_S", 0.01)
    monkeypatch.setattr(runner, "run", AsyncMock(return_value=(0, json.dumps({"show": [{"a": 1}]}).encode(), b"")))
    lock = runner._lock_for(pid)
    await lock.acquire()
    try:
        r = await client.post(f"/api/projects/{pid}/ai/messages/{query['id']}/run", json={"sql": "select 1 as a"})
        assert r.json()["payload"]["status"] == "waiting"
        again = await client.post(f"/api/projects/{pid}/ai/messages/{query['id']}/run", json={"sql": "select 1 as a"})
        assert again.status_code == 409
    finally:
        lock.release()
    await _wait(client, pid, cid, "done")


async def test_answer_needs_results(client, db_session, tmp_path, model):
    pid, cid = await _setup(client, db_session, tmp_path)
    _, query = (await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/query", json={"content": "q"})).json()
    assert (await client.post(f"/api/projects/{pid}/ai/messages/{query['id']}/answer")).status_code == 409


async def test_follow_up_history_includes_sql(client, db_session, tmp_path, model):
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    from app.db.models import AiConversation

    pid, cid = await _setup(client, db_session, tmp_path)
    await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/query", json={"content": "q"})
    conv = (await db_session.execute(
        select(AiConversation).where(AiConversation.id == cid).options(selectinload(AiConversation.messages))
    )).scalar_one()
    history = ai_chat.chat_history(conv)
    assert history[0] == {"role": "user", "content": "q"}
    assert history[1]["role"] == "assistant" and "```sql" in history[1]["content"]
