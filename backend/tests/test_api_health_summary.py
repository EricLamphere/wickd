import json
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import debug as debug_api
from app.db.engine import get_session
from app.db.models import AppSetting, DriftSnapshot, ModelStatus, Project
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def session():
    gen = app.dependency_overrides[get_session]()
    s = await gen.__anext__()
    yield s


@pytest.fixture(autouse=True)
def target():
    with patch("app.api.init.load_project_env", new=AsyncMock(return_value={"DBT_TARGET": "dev"})):
        yield


async def _project(session) -> int:
    p = Project(name="p", path="/tmp/p", platform="local")
    session.add(p)
    await session.commit()
    return p.id


async def test_summary_when_nothing_has_run(client, session):
    pid = await _project(session)
    resp = await client.get(f"/api/projects/{pid}/health/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert {k: body[k]["status"] for k in ("connection", "drift", "freshness")} == {
        "connection": "not_run", "drift": "not_run", "freshness": "not_run",
    }
    assert body["current_target"] == "dev"


async def test_summary_reports_drift_and_rebuilt_models(client, session):
    pid = await _project(session)
    finished = datetime.now(timezone.utc) - timedelta(minutes=10)
    session.add(DriftSnapshot(
        project_id=pid, status="done", target="dev", total_models=2, checked_models=2,
        finished_at=finished,
        results_json=json.dumps([
            {"unique_id": "model.p.a", "name": "a", "has_drift": True},
            {"unique_id": "model.p.b", "name": "b", "has_drift": False},
        ]),
    ))
    session.add(ModelStatus(project_id=pid, unique_id="model.p.b", kind="model", status="success",
                            finished_at=finished + timedelta(minutes=5)))
    session.add(ModelStatus(project_id=pid, unique_id="model.p.zzz", kind="model", status="success",
                            finished_at=finished + timedelta(minutes=5)))
    await session.commit()

    drift = (await client.get(f"/api/projects/{pid}/health/summary")).json()["drift"]
    assert drift["status"] == "warn" and drift["issues"] == 1
    assert drift["stale_reasons"] == ["1 model rebuilt since this scan"]


async def test_summary_connection_running_and_last_result(client, session):
    pid = await _project(session)
    session.add(AppSetting(key=f"health_check:{pid}", value=json.dumps({
        "overall_ok": True, "target_name": "dev", "requested_target": "dev",
        "finished_at": datetime.now(timezone.utc).isoformat(), "checks": [],
    })))
    await session.commit()

    conn = (await client.get(f"/api/projects/{pid}/health/summary")).json()["connection"]
    assert conn["status"] == "ok" and conn["stale_reasons"] == []

    debug_api.running_debug.add(pid)
    try:
        conn = (await client.get(f"/api/projects/{pid}/health/summary")).json()["connection"]
    finally:
        debug_api.running_debug.discard(pid)
    assert conn["status"] == "running"


async def test_summary_unknown_project_404(client):
    assert (await client.get("/api/projects/999/health/summary")).status_code == 404
