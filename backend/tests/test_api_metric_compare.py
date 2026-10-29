"""POST /semantic/compare (plan 14): both sides explained and run, aligned by the (stubbed) Pro module."""

import shutil
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project, ProjectEnvVar
from app.licensing import entitlements
from app.main import app
from app.semantic import compare, compare_pro, service, status
from app.semantic.batch import BatchResult
from app.semantic.revisions import SideManifest

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def _get_session():
        async with sessions() as s:
            yield s

    monkeypatch.setattr(db_engine, "SessionLocal", sessions)
    app.dependency_overrides[get_session] = _get_session
    async with sessions() as s:
        yield s
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def entitled(monkeypatch: pytest.MonkeyPatch) -> dict:
    state = {"entitled": True}

    async def _check(session):
        return entitlements.Entitlement(entitled=state["entitled"], reason="granted" if state["entitled"] else "not_licensed")

    monkeypatch.setattr(entitlements, "check_entitlement", _check)
    return state


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    """The worker explains per manifest, side manifests and run_many are recorded, Pro is stubbed."""
    base_manifest = tmp_path / "base" / "semantic_manifest.json"
    base_manifest.parent.mkdir()
    base_manifest.write_text("{}")
    rec: dict = {"sides": [], "runs": [], "explains": []}

    async def fake_env():
        return "1.10.0", "3.11"

    async def fake_request(op, payload=None, *, timeout=30.0):
        if op == "catalog":
            return {"metrics": [{"name": "revenue", "dimensions": []}, {"name": "revenue_v2", "dimensions": []}], "saved_queries": []}
        rec["explains"].append(payload)
        side = "base" if payload["manifest_path"] == str(base_manifest) else "current"
        return {"sql": f"select 1 as {side}_{'_'.join(payload['metrics'])}", "columns": []}

    async def fake_side(project, *, ref, target):
        rec["sides"].append((ref, target))
        if ref is None and target is None:
            return SideManifest(Path(project.path) / "target" / "semantic_manifest.json", None, None)
        return SideManifest(base_manifest, "abc123" if ref else None, target, ("note from checkout",) if ref else ())

    async def fake_run_many(project_id, project_path, sqls, *, limit=5000, target=None):
        rec["runs"].append((sqls, target))
        return [BatchResult(["metric_time__day", "revenue"], [["2026-01-01", 10 if "current" in s else 8]], False) for s in sqls]

    monkeypatch.setattr(status, "dbt_environment", fake_env)
    monkeypatch.setattr(service, "dbt_environment", fake_env)
    monkeypatch.setattr(service.metricflow_runtime, "request", fake_request)
    monkeypatch.setattr(compare, "side_manifest", fake_side)
    monkeypatch.setattr(compare, "run_many", fake_run_many)
    monkeypatch.setattr(compare_pro, "is_available", lambda: True)
    monkeypatch.setattr(compare_pro, "align", lambda c, b, keys, metrics, base_metrics=None: [
        {"key": ["k"], "status": "changed", "keys": keys, "base_metrics": base_metrics}])
    monkeypatch.setattr(compare_pro, "summarize", lambda rows, keys, metrics, time_column=None, side_names=("now", "before"): {
        "headline": "moved", "time_column": time_column, "side_names": list(side_names)})
    monkeypatch.setattr(compare_pro, "sql_diff", lambda a, b, d=None: f"{b} -> {a}")
    return rec


async def _project(db: AsyncSession, tmp_path: Path) -> Project:
    root = tmp_path / "proj"
    (root / "target").mkdir(parents=True)
    (root / "dbt_project.yml").write_text("name: jaffle\nprofile: jaffle\n")
    shutil.copy(FIXTURES / "dbt_1_12" / "manifest.json", root / "target" / "manifest.json")
    shutil.copy(FIXTURES / "dbt_1_12" / "semantic_manifest.json", root / "target" / "semantic_manifest.json")
    project = Project(name="jaffle", path=str(root))
    db.add(project)
    await db.commit()
    return project


QUERY = {"metrics": ["revenue"], "group_by": ["metric_time__day"]}


async def test_compare_is_pro(client, db, tmp_path, entitled, stubs) -> None:
    entitled["entitled"] = False
    project = await _project(db, tmp_path)
    res = await client.post(f"/api/projects/{project.id}/semantic/compare", json={"query": QUERY, "mode": "working"})
    assert res.status_code == 403 and res.json()["detail"]["error"] == "pro_feature_required"
    assert not stubs["runs"]


async def test_uncommitted_vs_head_on_the_active_target(client, db, tmp_path, entitled, stubs) -> None:
    project = await _project(db, tmp_path)
    res = await client.post(f"/api/projects/{project.id}/semantic/compare", json={"query": QUERY, "mode": "working"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert ("HEAD", None) in stubs["sides"]
    assert stubs["runs"] == [(["select 1 as current_revenue", "select 1 as base_revenue"], None)]  # one dbt show
    assert body["current"]["rows"] == [["2026-01-01", 10]] and body["base"]["rows"] == [["2026-01-01", 8]]
    assert body["base"]["ref"] == "HEAD" and body["base"]["sha"] == "abc123"
    assert body["diff"]["key_columns"] == ["metric_time__day"] and body["diff"]["summary"]["time_column"] == "metric_time__day"
    assert body["diff"]["sql_diff"] == "select 1 as base_revenue -> select 1 as current_revenue"
    assert any("DIFF_BASE_TARGET" in n for n in body["notes"]) and "note from checkout" in body["notes"]


async def test_base_target_setting_points_the_base_side_at_its_tables(client, db, tmp_path, entitled, stubs) -> None:
    project = await _project(db, tmp_path)
    db.add(ProjectEnvVar(project_id=project.id, key="DIFF_BASE_TARGET", value="prod"))
    await db.commit()
    working = (await client.post(f"/api/projects/{project.id}/semantic/compare", json={"query": QUERY, "mode": "working"})).json()
    assert ("HEAD", "prod") in stubs["sides"] and working["base"]["target"] == "prod"
    assert not any("DIFF_BASE_TARGET" in n for n in working["notes"])
    assert stubs["runs"][-1][1] == "prod" and len(stubs["runs"]) == 2  # two targets: two runs

    targets = (await client.post(f"/api/projects/{project.id}/semantic/compare", json={"query": QUERY, "mode": "targets"})).json()
    assert (None, "prod") in stubs["sides"] and targets["base"]["ref"] is None


async def test_targets_need_one_and_metrics_swap_the_metric(client, db, tmp_path, entitled, stubs) -> None:
    project = await _project(db, tmp_path)
    url = f"/api/projects/{project.id}/semantic/compare"
    none = await client.post(url, json={"query": QUERY, "mode": "targets"})
    assert none.status_code == 400 and none.json()["detail"]["error"] == "no_base_target"

    res = (await client.post(url, json={"query": QUERY, "mode": "metrics", "other_metric": "revenue_v2"})).json()
    assert res["base"]["query"]["metrics"] == ["revenue_v2"] and res["current"]["query"]["metrics"] == ["revenue"]
    assert res["diff"]["rows"][0]["base_metrics"] == {"revenue": "revenue_v2"}
    assert res["diff"]["summary"]["side_names"] == ["revenue", "revenue_v2"]
    missing = await client.post(url, json={"query": QUERY, "mode": "metrics"})
    assert missing.status_code == 400

    bad = await client.post(url, json={"query": QUERY, "mode": "branch", "base_ref": "--upload-pack=x"})
    assert bad.status_code == 422


async def test_compare_options(client, db, tmp_path, stubs) -> None:
    project = await _project(db, tmp_path)
    db.add(ProjectEnvVar(project_id=project.id, key="DIFF_BASE_TARGET", value="prod"))
    await db.commit()
    opts = (await client.get(f"/api/projects/{project.id}/semantic/compare/options")).json()
    assert opts["base_target"] == "prod" and opts["is_repo"] is False and opts["branch_base"] is None


async def test_a_metric_missing_before_says_so(client, db, tmp_path, entitled, stubs, monkeypatch) -> None:
    from app.semantic import service as svc

    project = await _project(db, tmp_path)
    real = svc.metricflow_runtime.request

    async def failing_base(op, payload=None, *, timeout=30.0):
        if op == "explain" and "base" in payload["manifest_path"]:
            raise svc.WorkerRequestError("manifest_invalid", "At least one time spine must be configured")
        return await real(op, payload, timeout=timeout)

    monkeypatch.setattr(svc.metricflow_runtime, "request", failing_base)
    body = (await client.post(f"/api/projects/{project.id}/semantic/compare", json={"query": QUERY, "mode": "working"})).json()
    assert body["base"]["missing"] is True and "no semantic layer at HEAD" in body["base"]["error"]
    assert body["current"]["rows"] == [["2026-01-01", 10]] and body["diff"] is None

