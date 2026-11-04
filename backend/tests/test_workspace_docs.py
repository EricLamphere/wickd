import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import workspace_docs
from app.config import settings
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import AppSetting, Project
from app.events.bus import bus
from app.main import app
from app.projects import docs_state


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
def clean_state(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    docs_state.reset()
    yield
    docs_state.reset()


async def _project(name: str, tmp_path: Path, ignored: bool = False) -> int:
    async with db_engine.SessionLocal() as session:
        row = Project(name=name, path=str(tmp_path / name), platform="duckdb", ignored=ignored)
        session.add(row)
        await session.commit()
        return row.id


def _write_docs(tmp_path: Path, project_id: int) -> None:
    d = tmp_path / "docs" / str(project_id)
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"metadata": {"project_name": "x"}, "nodes": {}}))
    (d / "catalog.json").write_text(json.dumps({"nodes": {}}))


async def test_lists_active_projects_with_docs_state_and_empty_selection(client, tmp_path):
    with_docs = await _project("with_docs", tmp_path)
    without = await _project("without", tmp_path)
    await _project("hidden", tmp_path, ignored=True)
    _write_docs(tmp_path, with_docs)

    res = await client.get("/api/workspace/docs")

    assert res.status_code == 200
    body = res.json()
    assert body["selection"] == []
    by_id = {p["id"]: p for p in body["projects"]}
    assert set(by_id) == {with_docs, without}
    assert by_id[with_docs]["generated_at"] is not None
    assert by_id[without]["generated_at"] is None
    assert by_id[without]["state"] == "idle"


async def test_selection_round_trips_and_dedupes_keeping_order(client, tmp_path):
    a = await _project("a", tmp_path)
    b = await _project("b", tmp_path)

    res = await client.put("/api/workspace/docs/selection", json={"project_ids": [b, a, b]})

    assert res.status_code == 200
    assert res.json()["project_ids"] == [b, a]
    assert (await client.get("/api/workspace/docs")).json()["selection"] == [b, a]


async def test_selection_rejects_unknown_projects(client, tmp_path):
    a = await _project("a", tmp_path)
    res = await client.put("/api/workspace/docs/selection", json={"project_ids": [a, 9999]})
    assert res.status_code == 400
    assert "9999" in res.json()["detail"]


async def test_selection_hides_projects_ignored_later(client, tmp_path):
    a = await _project("a", tmp_path)
    b = await _project("b", tmp_path)
    await client.put("/api/workspace/docs/selection", json={"project_ids": [a, b]})
    async with db_engine.SessionLocal() as session:
        (await session.get(Project, b)).ignored = True
        await session.commit()

    assert (await client.get("/api/workspace/docs")).json()["selection"] == [a]


async def test_corrupt_saved_selection_reads_as_empty(client, tmp_path):
    await _project("a", tmp_path)
    async with db_engine.SessionLocal() as session:
        session.add(AppSetting(key=workspace_docs.SELECTION_KEY, value="{not json"))
        await session.commit()

    assert (await client.get("/api/workspace/docs")).json()["selection"] == []


async def test_generate_runs_projects_one_at_a_time_and_reports_failures(client, tmp_path):
    a = await _project("a", tmp_path)
    b = await _project("b", tmp_path)
    running = 0
    peak = 0
    order: list[int] = []

    async def fake_generate(project_id: int, path: str):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        order.append(project_id)
        await asyncio.sleep(0)
        running -= 1
        if project_id == a:
            raise RuntimeError("dbt exploded")
        return True, []

    queue = await bus.subscribe("global")
    try:
        with patch.object(workspace_docs, "_generate_docs", side_effect=fake_generate):
            res = await client.post("/api/workspace/docs/generate", json={"project_ids": [a, b]})
            assert res.status_code == 202
            assert res.json()["queued"] == [a, b]
            await workspace_docs.wait_for_generation()
    finally:
        await bus.unsubscribe("global", queue)

    assert order == [a, b]  # one failure doesn't stop the rest
    assert peak == 1
    by_id = {p["id"]: p for p in (await client.get("/api/workspace/docs")).json()["projects"]}
    assert by_id[a]["state"] == "error"
    assert "dbt exploded" in by_id[a]["error"]


async def test_generate_skips_projects_already_queued(client, tmp_path):
    a = await _project("a", tmp_path)
    await docs_state.mark(a, "generating")

    with patch.object(workspace_docs, "_generate_docs", new=AsyncMock()) as generate:
        res = await client.post("/api/workspace/docs/generate", json={"project_ids": [a]})
        await workspace_docs.wait_for_generation()

    assert res.json()["queued"] == []
    generate.assert_not_called()


async def test_generate_rejects_unknown_projects(client):
    res = await client.post("/api/workspace/docs/generate", json={"project_ids": [404]})
    assert res.status_code == 400


async def test_mark_publishes_a_global_event():
    queue = await bus.subscribe("global")
    try:
        await docs_state.mark(7, "error", "boom")
        event = await asyncio.wait_for(queue.get(), timeout=2)
    finally:
        await bus.unsubscribe("global", queue)
    assert event.type == "workspace_docs"
    assert event.data == {"project_id": 7, "state": "error", "error": "boom"}


async def test_docs_data_still_merges_manifest_and_catalog(client, tmp_path):
    pid = await _project("a", tmp_path)
    d = tmp_path / "docs" / str(pid)
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({
        "metadata": {"project_name": "shop", "adapter_type": "duckdb"},
        "nodes": {"model.shop.orders": {
            "name": "orders", "resource_type": "model",
            "columns": {"id": {"description": "pk"}},
        }},
    }))
    (d / "catalog.json").write_text(json.dumps({"nodes": {"model.shop.orders": {
        "metadata": {"type": "BASE TABLE"},
        "columns": {"id": {"type": "INTEGER", "index": 1}},
    }}}))

    body = (await client.get(f"/api/projects/{pid}/docs/data")).json()

    assert body["project_name"] == "shop"
    assert body["nodes"][0]["columns"][0] == {
        "name": "id", "description": "pk", "data_type": "INTEGER", "meta": {}, "tags": [],
        "constraints": [], "tests": [],
    }


async def test_docs_data_404_before_generation(client, tmp_path):
    pid = await _project("a", tmp_path)
    assert (await client.get(f"/api/projects/{pid}/docs/data")).status_code == 404
