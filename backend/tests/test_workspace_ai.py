import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.ai import pro
from app.api import ai_chat, workspace_ai
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Project
from app.main import app

_real_supports_workspace_ask = pro.supports_workspace_ask  # the autouse fixture below mocks it


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def test_db_sessions(monkeypatch):
    """Point db_engine.SessionLocal at the in-memory test DB: without this, seeding and
    background writers would hit the real data/wickd.sqlite."""
    get_test_session = app.dependency_overrides[get_session]

    class TestSession:
        async def __aenter__(self):
            self._gen = get_test_session()
            return await anext(self._gen)

        async def __aexit__(self, *exc):
            await self._gen.aclose()

    monkeypatch.setattr(db_engine, "SessionLocal", TestSession)


@pytest.fixture(autouse=True)
def ai_ready():
    with patch.object(workspace_ai, "require_ai", new=AsyncMock()), \
         patch.object(workspace_ai, "load_ai_config", new=AsyncMock(return_value=object())), \
         patch.object(pro, "supports_workspace_ask", return_value=True):
        yield


async def _project(tmp_path: Path, name: str, *, compiled: bool = True, ignored: bool = False) -> int:
    path = tmp_path / name
    (path / "target").mkdir(parents=True)
    if compiled:
        (path / "target" / "manifest.json").write_text(json.dumps({
            "metadata": {"project_name": name},
            "nodes": {f"model.{name}.orders": {
                "name": "orders", "resource_type": "model", "package_name": name,
                "description": "All orders", "columns": {"order_id": {}},
                "depends_on": {"nodes": [f"source.{name}.raw.orders"]},
            }},
        }))
    async with db_engine.SessionLocal() as session:
        row = Project(name=name, path=str(path), platform="duckdb", ignored=ignored)
        session.add(row)
        await session.commit()
        return row.id


def _fake_stream(*chunks: str):
    async def stream(_provider, _messages, **_kw):
        for chunk in chunks:
            yield chunk
    return stream


async def _ask(client, cid: int, question: str):
    return await client.post(f"/api/workspace/ai/conversations/{cid}/messages", json={"content": question})


async def test_conversation_lifecycle(client):
    created = await client.post("/api/workspace/ai/conversations")
    assert created.status_code == 201
    cid = created.json()["id"]

    assert [c["id"] for c in (await client.get("/api/workspace/ai/conversations")).json()] == [cid]
    assert (await client.get(f"/api/workspace/ai/conversations/{cid}")).json()["messages"] == []

    assert (await client.delete(f"/api/workspace/ai/conversations/{cid}")).status_code == 204
    assert (await client.get(f"/api/workspace/ai/conversations/{cid}")).status_code == 404


async def test_ask_streams_saves_and_titles(client, tmp_path):
    await _project(tmp_path, "shop")
    cid = (await client.post("/api/workspace/ai/conversations")).json()["id"]

    with patch.object(pro, "workspace_ask_messages", return_value=[{"role": "user", "content": "q"}]), \
         patch.object(ai_chat, "resolve_provider", new=AsyncMock(return_value=object())), \
         patch.object(ai_chat, "stream_chat", new=_fake_stream("Look at ", "`shop/orders`")):
        res = await _ask(client, cid, "Where are orders?")

    assert res.status_code == 200
    assert "event: delta" in res.text and "event: done" in res.text
    detail = (await client.get(f"/api/workspace/ai/conversations/{cid}")).json()
    assert detail["title"] == "Where are orders?"
    assert [(m["role"], m["content"]) for m in detail["messages"]] == [
        ("user", "Where are orders?"),
        ("assistant", "Look at `shop/orders`"),
    ]


async def test_ask_scope_is_the_saved_selection_and_notes_uncompiled(client, tmp_path):
    shop = await _project(tmp_path, "shop")
    await _project(tmp_path, "finance")  # compiled, not selected
    empty = await _project(tmp_path, "empty", compiled=False)
    await client.put("/api/workspace/docs/selection", json={"project_ids": [shop, empty]})
    cid = (await client.post("/api/workspace/ai/conversations")).json()["id"]

    captured = {}

    def fake_messages(projects, not_compiled, history, question):
        captured.update(projects=projects, not_compiled=not_compiled, history=history, question=question)
        return []

    with patch.object(pro, "workspace_ask_messages", side_effect=fake_messages), \
         patch.object(ai_chat, "resolve_provider", new=AsyncMock(return_value=object())), \
         patch.object(ai_chat, "stream_chat", new=_fake_stream("ok")):
        await _ask(client, cid, "hi")

    assert [p["name"] for p in captured["projects"]] == ["shop"]
    assert captured["not_compiled"] == ["empty"]
    node = captured["projects"][0]["nodes"][0]
    assert node["name"] == "orders"
    assert node["columns"] == ["order_id"]
    assert node["depends_on"] == ["source.shop.raw.orders"]


async def test_ask_without_selection_covers_every_active_project(client, tmp_path):
    await _project(tmp_path, "shop")
    await _project(tmp_path, "finance")
    await _project(tmp_path, "hidden", ignored=True)
    cid = (await client.post("/api/workspace/ai/conversations")).json()["id"]
    seen: list[str] = []

    def fake_messages(projects, _not_compiled, _history, _question):
        seen.extend(p["name"] for p in projects)
        return []

    with patch.object(pro, "workspace_ask_messages", side_effect=fake_messages), \
         patch.object(ai_chat, "resolve_provider", new=AsyncMock(return_value=object())), \
         patch.object(ai_chat, "stream_chat", new=_fake_stream("ok")):
        await _ask(client, cid, "hi")

    assert sorted(seen) == ["finance", "shop"]


async def test_ask_sends_earlier_turns_as_history(client, tmp_path):
    await _project(tmp_path, "shop")
    cid = (await client.post("/api/workspace/ai/conversations")).json()["id"]
    histories: list[list[dict]] = []

    def fake_messages(_projects, _not_compiled, history, _question):
        histories.append(history)
        return []

    with patch.object(pro, "workspace_ask_messages", side_effect=fake_messages), \
         patch.object(ai_chat, "resolve_provider", new=AsyncMock(return_value=object())), \
         patch.object(ai_chat, "stream_chat", new=_fake_stream("first answer")):
        await _ask(client, cid, "first")
        await _ask(client, cid, "second")

    assert histories[0] == []
    assert histories[1] == [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "first answer"},
    ]


async def test_ask_nothing_compiled_is_a_clear_error_and_saves_nothing(client, tmp_path):
    await _project(tmp_path, "empty", compiled=False)
    cid = (await client.post("/api/workspace/ai/conversations")).json()["id"]

    res = await _ask(client, cid, "hi")

    assert res.status_code == 422
    assert "compiled" in res.json()["detail"]
    assert (await client.get(f"/api/workspace/ai/conversations/{cid}")).json()["messages"] == []


async def test_ask_older_pro_build_is_a_clear_error(client, tmp_path):
    await _project(tmp_path, "shop")
    cid = (await client.post("/api/workspace/ai/conversations")).json()["id"]

    with patch.object(pro, "supports_workspace_ask", return_value=False):
        res = await _ask(client, cid, "hi")

    assert res.status_code == 503
    assert "update" in res.json()["detail"].lower()


async def test_ask_unknown_conversation(client):
    assert (await _ask(client, 12345, "hi")).status_code == 404


async def test_ask_rejects_empty_question(client):
    cid = (await client.post("/api/workspace/ai/conversations")).json()["id"]
    assert (await _ask(client, cid, "   ")).status_code == 422


async def test_routes_require_ai(client):
    from fastapi import HTTPException

    with patch.object(workspace_ai, "require_ai", new=AsyncMock(side_effect=HTTPException(403, "pro"))):
        assert (await client.get("/api/workspace/ai/conversations")).status_code == 403


async def test_shim_reports_support_from_installed_build(monkeypatch):
    class Old:
        pass

    class New:
        @staticmethod
        def workspace_ask_messages(projects, not_compiled, history, question):
            return [projects, not_compiled, history, question]

    monkeypatch.setattr(pro, "_pro", lambda: Old)
    assert _real_supports_workspace_ask() is False
    monkeypatch.setattr(pro, "_pro", lambda: New)
    assert _real_supports_workspace_ask() is True
    assert pro.workspace_ask_messages([], ["x"], [], "q") == [[], ["x"], [], "q"]


