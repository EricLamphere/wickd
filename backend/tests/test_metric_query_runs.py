"""semantic/query_runs.py: background runs merge when started together, store results as they land,
and a cancelled run's unanswered queries go back to not run (not failed). Also the cancel routes."""

import asyncio
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import engine as db_engine
from app.db.models import Base, Project
from app.semantic import query_cache, query_control, query_runs
from app.semantic.batch import CANCELLED, BatchResult
from app.semantic.query_cache import CacheKey
from app.semantic.query_service import QueryContext

CTX = QueryContext(target="dev", env_fingerprint="fp", profile_name=None)


@pytest.fixture
async def sessions(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'runs.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    monkeypatch.setattr(db_engine, "SessionLocal", factory)
    yield factory
    await engine.dispose()


def _pending(n: int) -> query_runs.PendingQuery:
    return query_runs.PendingQuery(CacheKey(1, "dev", "fp", f"h{n}"), f"select {n}", ("m",))


async def test_runs_started_together_merge_and_store_as_they_land(sessions, monkeypatch) -> None:
    calls: list[list[str]] = []
    stored_midway: list[bool] = []

    async def fake_run_many(project_id, path, sqls, *, on_result=None, **_kw):
        calls.append(list(sqls))
        out = []
        for i, sql in enumerate(sqls):
            res = BatchResult(["n"], [[i]], False)
            await on_result(i, res)
            out.append(res)
        async with sessions() as s:  # the first result is readable before the run ends
            stored_midway.append(await query_cache.lookup(s, _pending(0).key) is not None)
        return out

    monkeypatch.setattr(query_runs, "run_many", fake_run_many)
    first = query_runs.start(1, Path("/p"), [_pending(0), _pending(1)], CTX)
    second = query_runs.start(1, Path("/p"), [_pending(2), _pending(1)], CTX)  # 1 is already running
    assert first == second and query_runs.status(_pending(2).key) == query_runs.RUNNING
    await query_runs.wait_idle()
    assert calls == [["select 0", "select 1", "select 2"]] and stored_midway == [True]
    assert all(query_runs.status(_pending(n).key) is None for n in range(3))


async def test_cancelled_queries_go_back_to_not_run(sessions, monkeypatch) -> None:
    async def fake_run_many(project_id, path, sqls, *, on_result=None, **_kw):
        ok = BatchResult(["n"], [[1]], False)
        await on_result(0, ok)
        return [ok, BatchResult([], [], False, CANCELLED, cancelled=True)]

    monkeypatch.setattr(query_runs, "run_many", fake_run_many)
    query_runs.start(1, Path("/p"), [_pending(10), _pending(11)], CTX)
    await query_runs.wait_idle()
    assert query_runs.status(_pending(11).key) is None  # not a failure: Run runs it again
    async with sessions() as s:
        assert await query_cache.lookup(s, _pending(10).key) is not None


async def test_cancel_route_stops_the_projects_metric_runs(client, db_session_project) -> None:
    project_id = db_session_project
    metrics = await query_control.start(project_id, "metrics", 10)
    other = await query_control.start(project_id, "data_diff", 2)
    try:
        active = (await client.get(f"/api/projects/{project_id}/semantic/queries/active")).json()["runs"]
        assert [r["run_id"] for r in active] == [metrics.run_id]  # data diffs have their own controls
        resp = await client.post(f"/api/projects/{project_id}/semantic/queries/cancel", json={})
        assert resp.json() == {"cancelled": 1} and metrics.cancelled and not other.cancelled
        resp = await client.post(f"/api/projects/{project_id}/semantic/queries/cancel", json={"run_ids": [other.run_id]})
        assert resp.json() == {"cancelled": 1} and other.cancelled
    finally:
        await query_control.finish(metrics)
        await query_control.finish(other)
    assert (await client.get("/api/projects/99999/semantic/queries/active")).status_code == 404


@pytest.fixture
async def db_session_project() -> int:
    from app.db.engine import get_session
    from app.main import app

    override = app.dependency_overrides[get_session]
    async for session in override():
        project = Project(name="p", path="/tmp/p")
        session.add(project)
        await session.commit()
        return project.id
    raise AssertionError("no session")


@pytest.fixture
async def client():
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_progress_is_throttled_but_always_finishes(monkeypatch) -> None:
    from app.events.bus import bus

    events = await bus.subscribe("project:31")
    try:
        run = await query_control.start(31, "metrics", 3)
        await query_control.advance(run)
        await query_control.advance(run)
        await query_control.finish(run)
        seen = []
        while not events.empty():
            seen.append(events.get_nowait().data)
        assert seen[0]["done"] == 0 and seen[-1] == {**seen[-1], "done": 2, "finished": True}
        assert len(seen) == 2  # the two advances fell inside the throttle window
    finally:
        await bus.unsubscribe("project:31", events)
    await asyncio.sleep(0)
