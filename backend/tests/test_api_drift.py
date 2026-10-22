import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api import drift as drift_api
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project
from app.dbt.probe import ProbeResult
from app.main import app


@pytest.fixture(autouse=True)
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Temp-file DB shared by FastAPI DI and the SessionLocal the background scan
    writes through (see test_api_column_lineage.py for why not ':memory:')."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'drift.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    TestSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with TestSessionLocal() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", TestSessionLocal)
    yield TestSessionLocal
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _table(name: str, columns: list[str]) -> dict:
    return {
        "unique_id": f"model.proj.{name}",
        "name": name,
        "resource_type": "model",
        "config": {"materialized": "table"},
        "original_file_path": f"models/{name}.sql",
        "columns": {c: {"name": c, "data_type": ""} for c in columns},
    }


async def _seed(db, tmp_path: Path, names: list[str]) -> int:
    d = tmp_path / "proj"
    (d / "target").mkdir(parents=True)
    nodes = {f"model.proj.{n}": _table(n, ["id"]) for n in names}
    (d / "target" / "manifest.json").write_text(json.dumps({"nodes": nodes, "sources": {}}))
    async with db() as session:
        project = Project(name="proj", path=str(d), platform="local")
        session.add(project)
        await session.commit()
        return project.id


async def _run_to_completion(client: AsyncClient, project_id: int) -> dict:
    resp = await client.post(f"/api/projects/{project_id}/drift", json={})
    assert resp.status_code == 202
    await drift_api._running[project_id]
    return (await client.get(f"/api/projects/{project_id}/drift")).json()


@pytest.fixture(autouse=True)
def project_env():
    with patch("app.api.init.load_project_env", new=AsyncMock(return_value={})):
        yield


async def test_drift_probes_models_in_batches(client, db, tmp_path, monkeypatch):
    names = ["a", "b", "c"]
    pid = await _seed(db, tmp_path, names)
    monkeypatch.setattr(drift_api, "PROBE_BATCH_SIZE", 2)

    async def _batch(_pid, _path, batch, _env, _target):
        return {n: ProbeResult(columns=("id", "extra"), error=None) for n in batch}

    batch = AsyncMock(side_effect=_batch)
    single = AsyncMock()
    with patch.object(drift_api, "probe_many_warehouse_columns", new=batch), \
         patch.object(drift_api, "probe_warehouse_columns", new=single):
        snap = await _run_to_completion(client, pid)

    assert [c.args[2] for c in batch.await_args_list] == [("a", "b"), ("c",)]
    single.assert_not_awaited()
    assert snap["status"] == "done"
    assert snap["checked_models"] == 3
    assert [r["name"] for r in snap["results"]] == names
    assert all(r["has_drift"] for r in snap["results"])


async def test_drift_falls_back_to_single_probes_when_batch_fails(client, db, tmp_path, monkeypatch):
    pid = await _seed(db, tmp_path, ["a", "b"])

    single = AsyncMock(side_effect=[
        ProbeResult(columns=("id",), error=None),
        ProbeResult(columns=(), error="relation does not exist"),
    ])
    with patch.object(drift_api, "probe_many_warehouse_columns", new=AsyncMock(return_value=None)), \
         patch.object(drift_api, "probe_warehouse_columns", new=single):
        snap = await _run_to_completion(client, pid)

    assert single.await_count == 2
    by_name = {r["name"]: r for r in snap["results"]}
    assert by_name["a"]["error"] is None and not by_name["a"]["has_drift"]
    assert by_name["b"]["error"] == "relation does not exist"
    assert snap["checked_models"] == 2


async def test_drift_publishes_progress_per_model(client, db, tmp_path, monkeypatch):
    from app.events.bus import bus

    pid = await _seed(db, tmp_path, ["a", "b", "c"])
    monkeypatch.setattr(drift_api, "PROBE_BATCH_SIZE", 2)

    async def _batch(_pid, _path, batch, _env, _target):
        return {n: ProbeResult(columns=("id",), error=None) for n in batch}

    queue = await bus.subscribe(f"project:{pid}")
    try:
        with patch.object(drift_api, "probe_many_warehouse_columns", new=AsyncMock(side_effect=_batch)):
            await _run_to_completion(client, pid)
        events = []
        while not queue.empty():
            events.append(await asyncio.wait_for(queue.get(), timeout=1))
    finally:
        await bus.unsubscribe(f"project:{pid}", queue)

    drift_events = [e for e in events if e.type.startswith("drift_")]
    progress = [
        (e.data["checked"], e.data["batch_start"], e.data["batch_end"])
        for e in drift_events if e.type == "drift_progress"
    ]
    # each batch is announced (nothing checked yet) before its per-model events
    assert progress == [(0, 1, 2), (1, 1, 2), (2, 1, 2), (2, 3, 3), (3, 3, 3)]
    assert drift_events[-1].type == "drift_finished"


async def _seed_mixed(db, tmp_path: Path) -> int:
    """Two tables (one documented in YAML) and two views the scan skips."""
    d = tmp_path / "proj"
    (d / "target").mkdir(parents=True)
    (d / "models").mkdir()
    (d / "models" / "schema.yml").write_text("version: 2\n")
    orders = {**_table("orders", ["id"]), "patch_path": "proj://models/schema.yml"}
    view = {**_table("v", []), "config": {"materialized": "view"}}
    nodes = {
        "model.proj.orders": orders,
        "model.proj.fresh": _table("fresh", ["id"]),
        "model.proj.v": view,
        "model.proj.v2": {**view, "unique_id": "model.proj.v2", "name": "v2"},
    }
    (d / "target" / "manifest.json").write_text(json.dumps({"nodes": nodes, "sources": {}}))
    async with db() as session:
        project = Project(name="proj", path=str(d), platform="local")
        session.add(project)
        await session.commit()
        return project.id


async def test_drift_reports_not_built_yaml_path_and_skipped(client, db, tmp_path):
    pid = await _seed_mixed(db, tmp_path)
    probes = {
        "fresh": ProbeResult(columns=(), error="not built", not_built=True),
        "orders": ProbeResult(columns=("id", "extra"), error=None),
    }
    with patch.object(drift_api, "probe_many_warehouse_columns", new=AsyncMock(return_value=probes)):
        snap = await _run_to_completion(client, pid)

    by_name = {r["name"]: r for r in snap["results"]}
    assert by_name["fresh"]["not_built"] and not by_name["fresh"]["has_drift"]
    assert by_name["orders"]["yaml_path"] == "models/schema.yml"
    assert by_name["fresh"]["yaml_path"] is None
    assert snap["skipped"] == {"view": 2}


async def test_recheck_replaces_one_model_in_the_snapshot(client, db, tmp_path):
    pid = await _seed_mixed(db, tmp_path)
    first = {
        "fresh": ProbeResult(columns=(), error="not built", not_built=True),
        "orders": ProbeResult(columns=("id", "extra"), error=None),
    }
    with patch.object(drift_api, "probe_many_warehouse_columns", new=AsyncMock(return_value=first)):
        snap = await _run_to_completion(client, pid)

    rebuilt = {"fresh": ProbeResult(columns=("id",), error=None)}
    with patch.object(drift_api, "probe_many_warehouse_columns", new=AsyncMock(return_value=rebuilt)) as probe:
        resp = await client.post(
            f"/api/projects/{pid}/drift/{snap['id']}/recheck", json={"unique_id": "model.proj.fresh"}
        )

    assert resp.status_code == 200
    assert probe.await_args.args[2] == ("fresh",)
    by_name = {r["name"]: r for r in resp.json()["results"]}
    assert not by_name["fresh"]["not_built"] and not by_name["fresh"]["has_drift"]
    assert by_name["orders"]["has_drift"]  # untouched
    assert [r["name"] for r in resp.json()["results"]] == ["fresh", "orders"]


async def test_recheck_unknown_model_is_404(client, db, tmp_path):
    pid = await _seed_mixed(db, tmp_path)
    with patch.object(drift_api, "probe_many_warehouse_columns", new=AsyncMock(return_value={
        "fresh": ProbeResult(columns=("id",), error=None),
        "orders": ProbeResult(columns=("id",), error=None),
    })):
        snap = await _run_to_completion(client, pid)
    resp = await client.post(
        f"/api/projects/{pid}/drift/{snap['id']}/recheck", json={"unique_id": "model.proj.v"}
    )
    assert resp.status_code == 404


async def test_recheck_while_scanning_is_409(client, db, tmp_path):
    pid = await _seed_mixed(db, tmp_path)
    gate = asyncio.Event()

    async def _slow(_pid, _path, batch, _env, _target):
        await gate.wait()
        return {n: ProbeResult(columns=("id",), error=None) for n in batch}

    with patch.object(drift_api, "probe_many_warehouse_columns", new=AsyncMock(side_effect=_slow)):
        start = await client.post(f"/api/projects/{pid}/drift", json={})
        resp = await client.post(
            f"/api/projects/{pid}/drift/{start.json()['id']}/recheck", json={"unique_id": "model.proj.orders"}
        )
        gate.set()
        await drift_api._running[pid]
    assert resp.status_code == 409
