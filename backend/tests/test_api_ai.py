"""AI routes: gating, model status, documentation proposals (accept/reject/stale), Ask chat."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.ai import pro
from app.ai.client import Provider
from app.ai.documentation import DocumentationError, DocumentationResult, FileChange
from app.api import ai_chat, ai_proposals
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project
from app.licensing import entitlements
from app.main import app

UID = "model.proj.orders"


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """File-backed DB shared by DI and the SessionLocal background tasks import."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'ai.sqlite'}", future=True)
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
def entitled(monkeypatch):
    _entitle(monkeypatch)
    monkeypatch.setattr(pro, "is_available", lambda: True)


@pytest.fixture(autouse=True)
def no_side_effects(monkeypatch):
    monkeypatch.setattr(ai_proposals, "_compile_model", AsyncMock())
    monkeypatch.setattr(ai_proposals, "load_project_env", AsyncMock(return_value={}))


async def _project(session: AsyncSession, tmp_path: Path) -> tuple[int, Path]:
    root = tmp_path / "proj"
    (root / "models").mkdir(parents=True)
    (root / "target").mkdir()
    (root / "target" / "manifest.json").write_text(json.dumps({"nodes": {}, "sources": {}}))
    project = Project(name="proj", path=str(root), platform="local")
    session.add(project)
    await session.commit()
    return project.id, root


async def _wait_status(client: AsyncClient, pid: int, proposal_id: int, status: str) -> dict:
    for _ in range(100):
        r = await client.get(f"/api/projects/{pid}/ai/proposals/{proposal_id}")
        if r.json()["status"] == status:
            return r.json()
        await asyncio.sleep(0.02)
    raise AssertionError(f"proposal never reached {status}: {r.json()}")


# ── gating + status ──────────────────────────────────────────────────────────


async def test_routes_require_pro(client, db_session, tmp_path, monkeypatch):
    _entitle(monkeypatch, entitled=False)
    pid, _ = await _project(db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "pro_feature_required"
    assert (await client.post("/api/ai/models/qwen3.5-4b/download")).status_code == 403


async def test_routes_503_without_pro_package(client, db_session, tmp_path, monkeypatch):
    _entitle(monkeypatch)
    monkeypatch.setattr(pro, "is_available", lambda: False)
    pid, _ = await _project(db_session, tmp_path)
    r = await client.get(f"/api/projects/{pid}/ai/conversations")
    assert r.status_code == 503


async def test_status_reports_not_ready_until_model_downloaded(client, db_session, entitled, monkeypatch, tmp_path):
    from app.api import ai_model
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(ai_model, "find_llama_server", lambda: Path("/bin/llama-server"))
    body = (await client.get("/api/ai/status")).json()
    assert body["entitled"] and body["runtime_installed"] and not body["ready"]
    assert body["model_id"] == "qwen3.5-4b"
    assert [m["id"] for m in body["models"]] == ["qwen3.5-4b", "qwen3.5-9b"]

    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "Qwen3.5-4B-Q4_K_M.gguf").write_bytes(b"x")
    assert (await client.get("/api/ai/status")).json()["ready"]


async def test_status_ready_with_endpoint(client, db_session, entitled, monkeypatch):
    from app.api import ai_model

    monkeypatch.setattr(ai_model, "find_llama_server", lambda: None)
    r = await client.put("/api/settings", json={"ai_endpoint_url": "http://localhost:11434/", "ai_endpoint_model": "qwen3"})
    assert r.status_code == 200
    assert r.json()["ai_endpoint_url"] == "http://localhost:11434/"
    body = (await client.get("/api/ai/status")).json()
    assert body["uses_endpoint"] and body["ready"]
    assert body["endpoint_url"] == "http://localhost:11434"


async def test_unknown_model_setting_rejected(client, db_session):
    r = await client.put("/api/settings", json={"ai_model": "gpt-99"})
    assert r.status_code == 400


# ── documentation proposals ──────────────────────────────────────────────────


def _fake_result(original: str | None, proposed: str) -> DocumentationResult:
    return DocumentationResult(
        change=FileChange("models/schema.yml", original, proposed),
        summary={"description": "One row per order.", "columns": {"id": "Order key."}},
        skipped_columns=0,
    )


async def test_document_accept_writes_file(client, db_session, entitled, tmp_path, monkeypatch):
    pid, root = await _project(db_session, tmp_path)
    monkeypatch.setattr(
        ai_proposals, "generate_documentation",
        AsyncMock(return_value=_fake_result(None, "version: 2\nmodels:\n  - name: orders\n")),
    )
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    assert r.status_code == 202 and r.json()["status"] == "generating"
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    file = proposal["files"][0]
    assert file["original_text"] is None
    assert not (root / "models" / "schema.yml").exists()  # nothing written before review

    listed = (await client.get(f"/api/projects/{pid}/ai/proposals", params={"unique_id": UID})).json()
    assert [p["id"] for p in listed] == [proposal["id"]]

    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{file['id']}/accept")
    assert r.status_code == 200 and r.json()["status"] == "applied"
    assert (root / "models" / "schema.yml").read_text() == file["proposed_text"]
    ai_proposals._compile_model.assert_called_once()
    assert (await client.get(f"/api/projects/{pid}/ai/proposals")).json() == []

    again = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{file['id']}/accept")
    assert again.status_code == 409


async def test_accept_refuses_when_file_changed(client, db_session, entitled, tmp_path, monkeypatch):
    pid, root = await _project(db_session, tmp_path)
    schema = root / "models" / "schema.yml"
    schema.write_text("models: []\n")
    monkeypatch.setattr(
        ai_proposals, "generate_documentation",
        AsyncMock(return_value=_fake_result("models: []\n", "models:\n  - name: orders\n")),
    )
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    schema.write_text("models: []\n# edited by hand\n")
    fid = proposal["files"][0]["id"]
    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{fid}/accept")
    assert r.status_code == 409
    assert "changed since" in r.json()["detail"]
    assert schema.read_text().endswith("# edited by hand\n")


async def test_reject_leaves_file_alone(client, db_session, entitled, tmp_path, monkeypatch):
    pid, root = await _project(db_session, tmp_path)
    monkeypatch.setattr(
        ai_proposals, "generate_documentation", AsyncMock(return_value=_fake_result(None, "x: 1\n"))
    )
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    fid = proposal["files"][0]["id"]
    r = await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{fid}/reject")
    assert r.json()["status"] == "rejected"
    assert not (root / "models" / "schema.yml").exists()


async def test_generation_error_is_recorded_and_dismissable(client, db_session, entitled, tmp_path, monkeypatch):
    pid, _ = await _project(db_session, tmp_path)
    monkeypatch.setattr(
        ai_proposals, "generate_documentation",
        AsyncMock(side_effect=DocumentationError("nothing to change")),
    )
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    proposal = await _wait_status(client, pid, r.json()["id"], "error")
    assert proposal["error_message"] == "nothing to change"
    assert (await client.delete(f"/api/projects/{pid}/ai/proposals/{proposal['id']}")).status_code == 204
    assert (await client.get(f"/api/projects/{pid}/ai/proposals")).json() == []


async def test_document_from_chat_stays_in_history(client, db_session, entitled, tmp_path, monkeypatch):
    pid, _ = await _project(db_session, tmp_path)
    monkeypatch.setattr(
        ai_proposals, "generate_documentation", AsyncMock(return_value=_fake_result(None, "x: 1\n"))
    )
    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]
    r = await client.post(
        f"/api/projects/{pid}/ai/document",
        json={"unique_id": UID, "overwrite": True, "conversation_id": cid},
    )
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    assert proposal["result"] == {
        "description": "One row per order.", "columns": {"id": "Order key."}, "tests": [],
        "selected": None, "accepted": [],
    }
    fid = proposal["files"][0]["id"]
    await client.post(f"/api/projects/{pid}/ai/proposals/{proposal['id']}/files/{fid}/accept")

    detail = (await client.get(f"/api/projects/{pid}/ai/conversations/{cid}")).json()
    assert detail["title"] == "Document orders (replace existing)"
    [action] = detail["messages"]
    assert action["role"] == "action" and action["content"] == "Document orders (replace existing)"
    assert action["proposal"]["status"] == "applied"
    assert action["proposal"]["result"]["columns"] == {"id": "Order key."}


async def test_dismissed_proposal_is_kept_for_history(client, db_session, entitled, tmp_path, monkeypatch):
    pid, _ = await _project(db_session, tmp_path)
    monkeypatch.setattr(
        ai_proposals, "generate_documentation", AsyncMock(return_value=_fake_result(None, "x: 1\n"))
    )
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    assert (await client.delete(f"/api/projects/{pid}/ai/proposals/{proposal['id']}")).status_code == 204
    assert (await client.get(f"/api/projects/{pid}/ai/proposals")).json() == []
    kept = (await client.get(f"/api/projects/{pid}/ai/proposals/{proposal['id']}")).json()
    assert kept["status"] == "dismissed"


async def test_document_unknown_conversation_404(client, db_session, entitled, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID, "conversation_id": 999})
    assert r.status_code == 404


async def test_nothing_to_document_is_empty_not_error(client, db_session, entitled, tmp_path, monkeypatch):
    from app.ai.documentation import NothingToDocument

    pid, _ = await _project(db_session, tmp_path)
    monkeypatch.setattr(
        ai_proposals, "generate_documentation",
        AsyncMock(side_effect=NothingToDocument("Everything already has a description.")),
    )
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    proposal = await _wait_status(client, pid, r.json()["id"], "empty")
    assert proposal["error_message"] == "Everything already has a description."


async def test_progress_events_are_published(client, db_session, entitled, tmp_path, monkeypatch):
    from app.events.bus import bus

    pid, _ = await _project(db_session, tmp_path)

    async def _gen(**kwargs):
        await kwargs["on_phase"]("writing")
        await kwargs["on_text"]('{"description": "One row')
        return _fake_result(None, "x: 1\n")

    monkeypatch.setattr(ai_proposals, "generate_documentation", _gen)
    monkeypatch.setattr(ai_proposals, "PROGRESS_INTERVAL_S", 0)
    queue = await bus.subscribe(f"project:{pid}")
    try:
        r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
        await _wait_status(client, pid, r.json()["id"], "ready")
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
    finally:
        await bus.unsubscribe(f"project:{pid}", queue)
    progress = [e.data for e in events if e.type == "ai_proposal_progress"]
    assert progress[0]["phase"] == "writing"
    assert any(p["text"] == '{"description": "One row' for p in progress)
    assert [e.data["status"] for e in events if e.type == "ai_proposal_updated"] == ["generating", "ready"]


async def test_second_document_request_while_generating_is_409(client, db_session, entitled, tmp_path, monkeypatch):
    pid, _ = await _project(db_session, tmp_path)
    release = asyncio.Event()

    async def _slow(**kwargs):
        await release.wait()
        return _fake_result(None, "x: 1\n")

    monkeypatch.setattr(ai_proposals, "generate_documentation", _slow)
    first = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    second = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    assert second.status_code == 409
    release.set()
    await _wait_status(client, pid, first.json()["id"], "ready")


# ── Ask chat ─────────────────────────────────────────────────────────────────


def _events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


async def test_ask_streams_and_saves_history(client, db_session, entitled, tmp_path, monkeypatch):
    pid, _ = await _project(db_session, tmp_path)
    captured: dict = {}

    def _messages(manifest, unique_id, history, question, run_info=None):
        captured.update(unique_id=unique_id, history=history, question=question)
        captured["run_status"] = (run_info or {}).get("status")
        return [{"role": "user", "content": question}]

    async def _stream(provider, messages, max_tokens=None):
        for part in ("It ", "sums ", "orders."):
            yield part

    monkeypatch.setattr(pro, "ask_messages", _messages)
    monkeypatch.setattr(ai_chat, "resolve_provider", AsyncMock(return_value=Provider("http://x/v1", "m")))
    monkeypatch.setattr(ai_chat, "stream_chat", _stream)

    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]
    r = await client.post(
        f"/api/projects/{pid}/ai/conversations/{cid}/messages",
        json={"content": "What does orders do?", "unique_id": UID},
    )
    assert r.status_code == 200
    events = _events(r.text)
    assert "".join(d["text"] for e, d in events if e == "delta") == "It sums orders."
    assert events[-1][0] == "done"
    assert captured == {
        "unique_id": UID, "history": [], "question": "What does orders do?", "run_status": None,
    }

    detail = (await client.get(f"/api/projects/{pid}/ai/conversations/{cid}")).json()
    assert detail["title"] == "What does orders do?"
    assert [(m["role"], m["content"]) for m in detail["messages"]] == [
        ("user", "What does orders do?"),
        ("assistant", "It sums orders."),
    ]
    listed = (await client.get(f"/api/projects/{pid}/ai/conversations")).json()
    assert [c["id"] for c in listed] == [cid]


async def test_ask_reports_runtime_errors_in_stream(client, db_session, entitled, tmp_path, monkeypatch):
    from app.ai.runtime import RuntimeUnavailable

    pid, _ = await _project(db_session, tmp_path)
    monkeypatch.setattr(pro, "ask_messages", lambda *a: [])
    monkeypatch.setattr(
        ai_chat, "resolve_provider", AsyncMock(side_effect=RuntimeUnavailable("not downloaded"))
    )
    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]
    r = await client.post(f"/api/projects/{pid}/ai/conversations/{cid}/messages", json={"content": "hi"})
    assert _events(r.text) == [("error", {"message": "not downloaded"})]
    detail = (await client.get(f"/api/projects/{pid}/ai/conversations/{cid}")).json()
    assert [m["role"] for m in detail["messages"]] == ["user"]


async def test_conversation_scoped_to_project(client, db_session, entitled, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]
    assert (await client.get(f"/api/projects/{pid + 1}/ai/conversations/{cid}")).status_code == 404
    assert (await client.delete(f"/api/projects/{pid}/ai/conversations/{cid}")).status_code == 204



# ── Add tests + Explain failure ──────────────────────────────────────────────


async def test_add_tests_route_records_action(client, db_session, entitled, tmp_path, monkeypatch):
    from app.ai.test_generation import TestsResult

    pid, _ = await _project(db_session, tmp_path)
    summary = {"tests": [{"column": "id", "test": "unique", "reason": "PK", "failures": 0}]}
    gen = AsyncMock(return_value=TestsResult(change=FileChange("models/schema.yml", None, "x: 1\n"), summary=summary))
    monkeypatch.setattr(ai_proposals, "generate_tests", gen)
    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]
    r = await client.post(f"/api/projects/{pid}/ai/tests", json={"unique_id": UID, "conversation_id": cid})
    assert r.status_code == 202 and r.json()["kind"] == "tests"
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    assert proposal["result"]["tests"] == summary["tests"]
    assert "overwrite" not in gen.call_args.kwargs
    detail = (await client.get(f"/api/projects/{pid}/ai/conversations/{cid}")).json()
    assert detail["messages"][0]["content"] == "Add tests to orders"


async def test_document_and_tests_can_run_side_by_side(client, db_session, entitled, tmp_path, monkeypatch):
    pid, _ = await _project(db_session, tmp_path)
    release = asyncio.Event()

    async def _slow(**kwargs):
        await release.wait()
        return _fake_result(None, "x: 1\n")

    monkeypatch.setattr(ai_proposals, "generate_documentation", _slow)
    monkeypatch.setattr(ai_proposals, "generate_tests", _slow)
    doc = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    tests = await client.post(f"/api/projects/{pid}/ai/tests", json={"unique_id": UID})
    assert doc.status_code == 202 and tests.status_code == 202
    release.set()
    await _wait_status(client, pid, tests.json()["id"], "ready")


async def test_explain_failure_sends_run_info_and_failing_rows(client, db_session, entitled, tmp_path, monkeypatch):
    from app.db.models import ModelStatus

    pid, root = await _project(db_session, tmp_path)
    test_uid = "test.proj.not_null_orders_id.abc"
    (root / "target" / "manifest.json").write_text(json.dumps({"nodes": {
        UID: {"name": "orders", "resource_type": "model"},
        test_uid: {"name": "not_null_orders_id", "resource_type": "test", "attached_node": UID,
                   "column_name": "id", "test_metadata": {"name": "not_null"}},
    }}))
    db_session.add_all([
        ModelStatus(project_id=pid, unique_id=UID, kind="model", status="success"),
        ModelStatus(project_id=pid, unique_id=test_uid, kind="test", status="error",
                    message="Got 3 results, configured to fail if != 0"),
    ])
    await db_session.commit()
    captured: dict = {}

    def _explain(manifest, unique_id, run_info, history, question):
        captured.update(run_info=run_info, question=question)
        return []

    async def _stream(provider, messages, max_tokens=None):
        yield "Because ids are null."

    monkeypatch.setattr(pro, "explain_failure_messages", _explain)
    monkeypatch.setattr(ai_chat, "failing_rows", AsyncMock(return_value=[{"unique_id": test_uid, "columns": ["id"], "rows": [[None]]}]))
    monkeypatch.setattr(ai_chat, "load_project_env", AsyncMock(return_value={}))
    monkeypatch.setattr(ai_chat, "resolve_provider", AsyncMock(return_value=Provider("http://x/v1", "m")))
    monkeypatch.setattr(ai_chat, "stream_chat", _stream)

    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]
    r = await client.post(
        f"/api/projects/{pid}/ai/conversations/{cid}/messages",
        json={"content": "Explain why orders is failing", "unique_id": UID, "mode": "explain_failure"},
    )
    assert _events(r.text)[-1][0] == "done"
    info = captured["run_info"]
    assert info["status"] == "success"
    assert info["tests"][0] == {
        "unique_id": test_uid, "name": "not_null_orders_id", "column": "id", "test": "not_null",
        "status": "error", "message": "Got 3 results, configured to fail if != 0",
    }
    assert info["failing_rows"][0]["rows"] == [[None]]


async def test_explain_failure_needs_a_node(client, db_session, entitled, tmp_path):
    pid, _ = await _project(db_session, tmp_path)
    cid = (await client.post(f"/api/projects/{pid}/ai/conversations")).json()["id"]
    r = await client.post(
        f"/api/projects/{pid}/ai/conversations/{cid}/messages",
        json={"content": "why", "mode": "explain_failure"},
    )
    assert r.status_code == 422


# ── partial accept ───────────────────────────────────────────────────────────


async def test_select_subset_of_tests_rebuilds_file(client, db_session, entitled, tmp_path, monkeypatch):
    import yaml

    from app.ai.test_generation import TestsResult

    pid, root = await _project(db_session, tmp_path)
    original = "version: 2\nmodels:\n  - name: orders\n"
    (root / "models" / "schema.yml").write_text(original)
    tests = [
        {"key": "t0", "column": "id", "test": "unique", "reason": "", "failures": 0,
         "spec": {"name": "unique", "args": {}}},
        {"key": "t1", "column": "id", "test": "not_null", "reason": "", "failures": 0,
         "spec": {"name": "not_null", "args": {}}},
        {"key": "t2", "column": "status", "test": "accepted_values", "reason": "", "failures": 1,
         "spec": {"name": "accepted_values", "args": {"values": ["a"]}}},
    ]
    summary = {"tests": tests, "plan": {"resource_key": "models", "name": "orders", "dbt_version": "1.9.0"}}
    monkeypatch.setattr(ai_proposals, "generate_tests", AsyncMock(return_value=TestsResult(
        change=FileChange("models/schema.yml", original, "full"), summary=summary,
    )))
    r = await client.post(f"/api/projects/{pid}/ai/tests", json={"unique_id": UID})
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    base = f"/api/projects/{pid}/ai/proposals/{proposal['id']}"

    r = await client.put(f"{base}/selection", json={"keys": ["t0", "t2"], "accepted": ["t2", "t1"]})
    assert r.status_code == 200
    assert r.json()["result"]["selected"] == ["t0", "t2"]
    assert r.json()["result"]["accepted"] == ["t2"]  # a removed item can't stay accepted
    cols = yaml.safe_load(r.json()["files"][0]["proposed_text"])["models"][0]["columns"]
    assert cols == [
        {"name": "id", "data_tests": ["unique"]},
        {"name": "status", "data_tests": [{"accepted_values": {"values": ["a"]}}]},
    ]

    assert (await client.put(f"{base}/selection", json={"keys": ["t9"]})).status_code == 422

    await client.put(f"{base}/selection", json={"keys": []})
    fid = proposal["files"][0]["id"]
    assert (await client.post(f"{base}/files/{fid}/accept")).status_code == 409

    await client.put(f"{base}/selection", json={"keys": ["t1"]})
    assert (await client.post(f"{base}/files/{fid}/accept")).status_code == 200
    written = yaml.safe_load((root / "models" / "schema.yml").read_text())
    assert written["models"][0]["columns"] == [{"name": "id", "data_tests": ["not_null"]}]


async def test_select_subset_of_descriptions(client, db_session, entitled, tmp_path, monkeypatch):
    import yaml

    pid, _ = await _project(db_session, tmp_path)
    summary = {
        "description": "One row per order.",
        "columns": {"id": "Key.", "amount": "Total."},
        "plan": {"resource_key": "models", "name": "orders", "columns": ["id", "amount"], "overwrite": False},
    }
    monkeypatch.setattr(ai_proposals, "generate_documentation", AsyncMock(return_value=DocumentationResult(
        change=FileChange("models/schema.yml", None, "full"), summary=summary, skipped_columns=0,
    )))
    r = await client.post(f"/api/projects/{pid}/ai/document", json={"unique_id": UID})
    proposal = await _wait_status(client, pid, r.json()["id"], "ready")
    r = await client.put(
        f"/api/projects/{pid}/ai/proposals/{proposal['id']}/selection", json={"keys": ["col:amount"]}
    )
    model = yaml.safe_load(r.json()["files"][0]["proposed_text"])["models"][0]
    assert "description" not in model
    assert model["columns"] == [{"name": "id"}, {"name": "amount", "description": "Total."}]
