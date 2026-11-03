"""Data diff (plan 06) routes and job: gating, target settings, filter validation, the job's
lifecycle (resolve → probe → strategy → wickd_pro steps batched per connection → snapshots →
events), per-model failures and cancel. dbt, the warehouse and wickd_pro are faked."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api import data_diff as api
from app.data_diff import job
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, DataDiffSnapshot, Project, ProjectEnvVar
from app.dbt import data_diff
from app.dbt.connection_info import TargetConnection
from app.dbt.probe import ProbeResult
from app.events.bus import bus
from app.licensing import entitlements
from app.main import app
from app.semantic.batch import BatchResult

ORDERS = "model.proj.orders"
GONE = "model.proj.gone"


def _manifest(prefix: str) -> dict:
    return {"metadata": {"adapter_type": "duckdb", "project_name": "proj"}, "nodes": {
        ORDERS: {"name": "orders", "resource_type": "model", "relation_name": f'"{prefix}"."main"."orders"',
                 "config": {"materialized": "table"},
                 "constraints": [{"type": "primary_key", "columns": ["id"]}]},
        GONE: {"name": "gone", "resource_type": "model", "relation_name": f'"{prefix}"."main"."gone"',
               "config": {"materialized": "table"}},
    }}


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'd.sqlite'}", future=True)
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
async def project(db_session: AsyncSession, tmp_path: Path) -> Project:
    path = tmp_path / "proj"
    (path / "target").mkdir(parents=True)
    (path / "target" / "manifest.json").write_text(json.dumps(_manifest("dev")))
    p = Project(name="proj", path=str(path))
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    db_session.add(ProjectEnvVar(project_id=p.id, key="DIFF_BASE_TARGET", value="prod"))
    await db_session.commit()
    return p


def _steps(spec: dict):
    """A fake wickd_pro generator: one round asking for a count on each side."""
    got = yield {"dev": [f"count {spec['dev_relation']}"], "prod": [f"count {spec['prod_relation']}"]}
    return {"mode": spec["mode"], "key": spec["key"], "counts": {"dev_rows": got["dev"][0]["rows"][0][0],
            "prod_rows": got["prod"][0]["rows"][0][0], "added": 1, "removed": 0, "changed": 0},
            "headline": "1 added", "notes": ["from pro"], "error": None}


@pytest.fixture
def faked(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    calls: dict = {"run_many": [], "probe": []}

    async def env(project_id):
        return {"DBT_TARGET": "dev"}

    async def connection(project_id, path, target, env):
        return TargetConnection(target=target, adapter_type="duckdb", fields={"path": f"{target}.duckdb"}, connected=True)

    async def prod_manifest(project, target):
        return _manifest("prod")

    async def probe(project_id, path, names, env, target, target_path=None):
        calls["probe"].append((target, names, target_path is not None))
        return {"orders": ProbeResult(columns=("id", "amount"), error=None, types=("INTEGER", "DOUBLE")),
                "gone": ProbeResult(columns=(), error="x", not_built=target == "prod")}

    async def run_many(project_id, path, sqls, *, target=None, limit=5000):
        calls["run_many"].append((target, list(sqls)))
        return [BatchResult(["n"], [[10 if target == "dev" else 9]], False) for _ in sqls]

    async def structure(project_id):
        return {}

    monkeypatch.setattr(api, "load_project_env", env)
    monkeypatch.setattr(job, "target_connection", connection)
    monkeypatch.setattr(job, "manifest_for_target", prod_manifest)
    monkeypatch.setattr(job, "probe_many_warehouse_columns", probe)
    monkeypatch.setattr(job, "run_many", run_many)
    monkeypatch.setattr(job, "_structure", structure)
    monkeypatch.setattr(data_diff, "_pro", lambda: SimpleNamespace(diff_steps=_steps, supports_separate=lambda a: True))
    _entitle(monkeypatch)
    return calls


async def _wait(project_id: int) -> None:
    await asyncio.wait_for(api._running[project_id], timeout=5)


async def test_routes_are_gated(client, project, monkeypatch) -> None:
    _entitle(monkeypatch, entitled=False)
    resp = await client.post(f"/api/projects/{project.id}/data-diff", json={"unique_ids": [ORDERS]})
    assert resp.status_code == 403 and resp.json()["detail"]["error"] == "pro_feature_required"
    assert (await client.get(f"/api/projects/{project.id}/data-diff/latest")).status_code == 403
    _entitle(monkeypatch)

    def missing():
        raise data_diff.DataDiffUnavailable(data_diff.UNAVAILABLE)

    monkeypatch.setattr(data_diff, "_pro", missing)
    assert (await client.get(f"/api/projects/{project.id}/data-diff/latest")).status_code == 503


async def test_needs_a_base_target_that_differs(client, project, faked, db_session) -> None:
    row = (await db_session.execute(select(ProjectEnvVar).where(ProjectEnvVar.key == "DIFF_BASE_TARGET"))).scalar_one()
    row.value = "dev"
    await db_session.commit()
    resp = await client.post(f"/api/projects/{project.id}/data-diff", json={"unique_ids": [ORDERS]})
    assert resp.status_code == 400 and resp.json()["detail"]["error"] == "same_target"
    await db_session.delete(row)
    await db_session.commit()
    resp = await client.post(f"/api/projects/{project.id}/data-diff", json={"unique_ids": [ORDERS]})
    assert resp.json()["detail"]["error"] == "no_base_target"


async def test_bad_filter_is_refused(client, project, faked) -> None:
    resp = await client.post(f"/api/projects/{project.id}/data-diff",
                             json={"unique_ids": [ORDERS], "where": {ORDERS: "1=1; drop table x"}})
    assert resp.status_code == 400 and resp.json()["detail"]["error"] == "invalid_filter"


async def test_job_diffs_models_and_reports_failures(client, project, faked) -> None:
    queue = await bus.subscribe(f"project:{project.id}")
    try:
        resp = await client.post(f"/api/projects/{project.id}/data-diff",
                                 json={"unique_ids": [ORDERS, GONE], "build": False, "where": {ORDERS: "id > 1"}})
        assert resp.status_code == 202
        assert [s["status"] for s in resp.json()] == ["running", "running"]
        await _wait(project.id)
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
    finally:
        await bus.unsubscribe(f"project:{project.id}", queue)

    types = [e.type for e in events if e.type.startswith("data_diff")]
    assert types[0] == "data_diff_started" and types[-1] == "data_diff_finished"
    assert {e.data["phase"] for e in events if e.type == "data_diff_progress"} >= {"resolving", "probing", "comparing"}
    # prod probed with its own target path; dev / prod paths differ → separate, no access probe
    assert faked["probe"] == [("dev", ("gone", "orders"), False), ("prod", ("gone", "orders"), True)]
    assert faked["run_many"] == [("dev", ['count "dev"."main"."orders"']), ("prod", ['count "prod"."main"."orders"'])]

    latest = (await client.get(f"/api/projects/{project.id}/data-diff/latest")).json()
    by_uid = {s["unique_id"]: s for s in latest}
    orders = by_uid[ORDERS]
    assert orders["status"] == "done" and orders["mode"] == "separate"
    assert orders["key"] == ["id"] and orders["key_source"] == "contract"
    assert orders["where"] == "id > 1"
    assert orders["result"]["counts"]["dev_rows"] == 10
    assert any("`path` differs" in n for n in orders["result"]["notes"]) and "from pro" in orders["result"]["notes"]
    gone = by_uid[GONE]
    assert gone["status"] == "error" and "doesn't exist on `prod`" in gone["error_message"]
    one = (await client.get(f"/api/projects/{project.id}/data-diff/{orders['id']}")).json()
    assert one["id"] == orders["id"]
    only = (await client.get(f"/api/projects/{project.id}/data-diff/latest", params={"unique_id": GONE})).json()
    assert [s["unique_id"] for s in only] == [GONE]


async def test_prod_connection_failure_fails_the_job(client, project, faked, monkeypatch) -> None:
    async def connection(project_id, path, target, env):
        return TargetConnection(target=target, adapter_type="duckdb", connected=target == "dev", error="bad password")

    monkeypatch.setattr(job, "target_connection", connection)
    await client.post(f"/api/projects/{project.id}/data-diff", json={"unique_ids": [ORDERS], "build": False})
    await _wait(project.id)
    latest = (await client.get(f"/api/projects/{project.id}/data-diff/latest")).json()
    assert latest[0]["status"] == "error" and "bad password" in latest[0]["error_message"]


async def test_cancel(client, project, faked, monkeypatch, db_session) -> None:
    started = asyncio.Event()

    async def slow(project_id, path, target, env):
        started.set()
        await asyncio.sleep(30)

    monkeypatch.setattr(job, "target_connection", slow)
    await client.post(f"/api/projects/{project.id}/data-diff", json={"unique_ids": [ORDERS], "build": False})
    await asyncio.wait_for(started.wait(), 5)
    again = await client.post(f"/api/projects/{project.id}/data-diff", json={"unique_ids": [ORDERS], "build": False})
    assert again.status_code == 409
    resp = await client.post(f"/api/projects/{project.id}/data-diff/cancel")
    assert resp.json() == {"cancelled": True}
    with pytest.raises(asyncio.CancelledError):
        await _wait(project.id)
    snap = (await db_session.execute(select(DataDiffSnapshot))).scalars().all()[-1]
    await db_session.refresh(snap)
    assert snap.status == "error" and snap.error_message == "Cancelled"
