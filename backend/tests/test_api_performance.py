"""Performance API: Base node durations, and the Pro analysis routes' gating
(403 not entitled / 503 package missing) and response shape. The Pro shim is
stubbed, so these tests never need wickd_pro installed.
"""
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient

from app.db.engine import get_session
from app.db.models import InvocationModelResult, Project, RunInvocation
from app.licensing import entitlements
from app.main import app
from app.performance import pro

T0 = datetime(2026, 10, 22, 10, tzinfo=UTC)


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def entitled(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _yes(_session):
        return entitlements.Entitlement(entitled=True, reason="granted")

    monkeypatch.setattr(entitlements, "check_entitlement", _yes)


@pytest.fixture
def stub_pro(monkeypatch: pytest.MonkeyPatch) -> dict:
    calls: dict = {}

    def analyze_run(nodes, parents, threads):
        calls["analyze"] = (nodes, parents, threads)
        return {
            "has_timing": True, "run_started_at": T0.isoformat(), "wall_time": 10.0, "ideal_time": 6.0,
            "potential_saving_s": 4.0, "threads": threads or 1, "busy_time": 8.0, "utilisation": 0.8,
            "critical_path": [{
                "unique_id": "model.p.a", "name": "a", "resource_type": "model", "materialized": "table",
                "duration_s": 6.0, "share": 0.6, "wait_before_s": 0.0, "wait_kind": None,
            }],
            "critical_path_waiting_s": 0.0, "starvation_s": 0.0, "durations": {"model.p.a": 6.0},
        }

    def detect_regressions(history):
        calls.setdefault("regressions", []).append(history)
        return [{"unique_id": "model.p.a", "name": "a", "current": 6.0, "baseline_median": 2.0,
                 "ratio": 3.0, "runs_considered": 3}]

    def recommend(analysis, meta, history):
        calls["recommend"] = (meta, history)
        return [{"kind": "make_incremental", "unique_id": "model.p.a", "name": "a", "title": "Make a incremental",
                 "evidence": ["slow"], "confidence": "medium", "estimated_saving_s": None}]

    monkeypatch.setattr(pro, "is_available", lambda: True)
    monkeypatch.setattr(pro, "analyze_run", analyze_run)
    monkeypatch.setattr(pro, "detect_regressions", detect_regressions)
    monkeypatch.setattr(pro, "recommend", recommend)
    return calls


async def _seed(tmp_path) -> tuple[int, list[int]]:
    """A project with four `build` runs of model.p.a (2s, 2s, 2s, then 6s with timing)."""
    get = app.dependency_overrides[get_session]
    async for session in get():
        proj = Project(name="p", path=str(tmp_path), platform="duckdb")
        session.add(proj)
        await session.commit()
        inv_ids = []
        for i, t in enumerate([2.0, 2.0, 2.0, 6.0]):
            inv = RunInvocation(project_id=proj.id, command="build", status="success", threads=4)
            session.add(inv)
            await session.commit()
            inv_ids.append(inv.id)
            timed = i == 3
            session.add(InvocationModelResult(
                invocation_id=inv.id, project_id=proj.id, unique_id="model.p.a", name="a", kind="model",
                status="success", execution_time=t,
                started_at=T0 if timed else None,
                completed_at=T0 + timedelta(seconds=t) if timed else None,
                thread_id="T1" if timed else None,
            ))
            await session.commit()
        return proj.id, inv_ids
    raise AssertionError("unreachable")


async def test_node_durations_is_base(client: AsyncClient, tmp_path) -> None:
    project_id, _ = await _seed(tmp_path)
    body = (await client.get(f"/api/projects/{project_id}/node-durations?command=build")).json()
    assert body["nodes"]["model.p.a"] == {"median_s": 2.0, "last_s": 6.0, "runs": 4}
    other = (await client.get(f"/api/projects/{project_id}/node-durations?command=seed")).json()
    assert other == {"nodes": {}}


async def test_node_durations_unknown_project_404(client: AsyncClient) -> None:
    assert (await client.get("/api/projects/999/node-durations")).status_code == 404


@pytest.mark.parametrize("path", ["/run-history/{inv}/analysis", "/performance"])
async def test_pro_routes_403_without_entitlement(
    client: AsyncClient, tmp_path, monkeypatch: pytest.MonkeyPatch, path: str
) -> None:
    async def _no(_session):
        return entitlements.Entitlement(entitled=False, reason="not_licensed")

    monkeypatch.setattr(entitlements, "check_entitlement", _no)
    project_id, inv_ids = await _seed(tmp_path)
    resp = await client.get(f"/api/projects/{project_id}" + path.format(inv=inv_ids[-1]))
    assert resp.status_code == 403
    assert resp.json()["detail"] == {"error": "pro_feature_required", "reason": "not_licensed"}


@pytest.mark.parametrize("path", ["/run-history/{inv}/analysis", "/performance"])
async def test_pro_routes_503_without_package(
    client: AsyncClient, tmp_path, monkeypatch: pytest.MonkeyPatch, entitled, path: str
) -> None:
    monkeypatch.setattr(pro, "is_available", lambda: False)
    project_id, inv_ids = await _seed(tmp_path)
    resp = await client.get(f"/api/projects/{project_id}" + path.format(inv=inv_ids[-1]))
    assert resp.status_code == 503


async def test_run_analysis_shape_and_inputs(client: AsyncClient, tmp_path, entitled, stub_pro: dict) -> None:
    project_id, inv_ids = await _seed(tmp_path)

    body = (await client.get(f"/api/projects/{project_id}/run-history/{inv_ids[-1]}/analysis")).json()

    assert body["has_timing"] is True and body["reason"] is None
    assert body["critical_path"][0]["unique_id"] == "model.p.a"
    assert body["regressions"][0]["ratio"] == 3.0
    assert body["recommendations"][0]["kind"] == "make_incremental"
    nodes, parents, threads = stub_pro["analyze"]
    assert threads == 4
    assert parents == {"model.p.a": []}
    assert nodes[0]["started_at"].startswith("2026-10-22T10:00:00")
    [history] = stub_pro["regressions"]
    assert history == [{"unique_id": "model.p.a", "name": "a", "previous": [2.0, 2.0, 2.0], "current": 6.0}]
    _, recommend_history = stub_pro["recommend"]
    assert recommend_history == {"model.p.a": [2.0, 2.0, 2.0, 6.0]}


async def test_run_analysis_wrong_project_404(client: AsyncClient, tmp_path, entitled, stub_pro) -> None:
    _, inv_ids = await _seed(tmp_path)
    get = app.dependency_overrides[get_session]
    async for session in get():
        other = Project(name="other", path=str(tmp_path / "o"), platform="duckdb")
        session.add(other)
        await session.commit()
        other_id = other.id
    resp = await client.get(f"/api/projects/{other_id}/run-history/{inv_ids[-1]}/analysis")
    assert resp.status_code == 404


async def test_project_performance_shape(client: AsyncClient, tmp_path, entitled, stub_pro: dict) -> None:
    project_id, inv_ids = await _seed(tmp_path)

    body = (await client.get(f"/api/projects/{project_id}/performance?command=build")).json()

    assert body["runs_considered"] == 4
    assert body["runs_with_timing"] == 1
    assert body["slowest"][0] == {
        "unique_id": "model.p.a", "name": "a", "resource_type": "model",
        "median_s": 2.0, "last_s": 6.0, "runs": 4, "recent": [2.0, 2.0, 2.0, 6.0],
    }
    assert body["recommendations"][0]["invocation_id"] == inv_ids[-1]
    # Project-wide regressions: each node's latest result vs its earlier ones in the window
    assert stub_pro["regressions"][-1] == [
        {"unique_id": "model.p.a", "name": "a", "previous": [2.0, 2.0, 2.0], "current": 6.0},
    ]


async def test_analysis_failure_is_a_500_with_message(
    client: AsyncClient, tmp_path, entitled, stub_pro, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(*_args):
        raise RuntimeError("bug")

    monkeypatch.setattr(pro, "analyze_run", _boom)
    project_id, inv_ids = await _seed(tmp_path)
    resp = await client.get(f"/api/projects/{project_id}/run-history/{inv_ids[-1]}/analysis")
    assert resp.status_code == 500
    assert "Performance analysis failed" in resp.json()["detail"]
