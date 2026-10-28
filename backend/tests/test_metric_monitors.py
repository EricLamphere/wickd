"""Metric monitors: the refresh job (batched queries stubbed, the Pro shim faked), the
post-run and interval triggers, and the routes incl. Pro gating. Never needs wickd_pro."""

import asyncio
import json
import shutil
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import (
    Base,
    MetricMonitor,
    MetricMonitorPoint,
    MetricMonitorRun,
    Project,
    ProjectEnvVar,
)
from app.events.bus import bus
from app.licensing import entitlements
from app.main import app
from app.semantic import anomaly, monitors, service, status
from app.semantic.batch import BatchResult

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"
SQL = "SELECT metric_time__day, SUM(amount) AS revenue FROM orders GROUP BY 1"
DIMENSIONS = [
    {"name": "customer__region", "type": "categorical", "time_granularity": None},
    {"name": "metric_time", "type": "time", "time_granularity": "day"},
]


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'mon.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with sessions() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", sessions)
    monitors.running.clear()
    monitors._pending.clear()
    async with sessions() as session:
        yield session
    await _settle()
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
def worker(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict]]:
    calls: list[tuple[str, dict]] = []

    async def fake_request(op: str, payload: dict | None = None, *, timeout: float = 30.0) -> dict:
        calls.append((op, payload or {}))
        if op == "explain":
            return {"sql": SQL, "columns": []}
        if op == "catalog":
            return {"metrics": [{"name": "revenue", "dimensions": DIMENSIONS},
                                {"name": "order_count", "dimensions": DIMENSIONS}], "saved_queries": []}
        return {}

    async def fake_env():
        return ("1.12.6", "3.12")

    monkeypatch.setattr(service.metricflow_runtime, "request", fake_request)
    monkeypatch.setattr(status, "dbt_environment", fake_env)
    monkeypatch.setattr(service, "dbt_environment", fake_env)
    return calls


@pytest.fixture
def entitled(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _yes(_session, **_kw):
        return entitlements.Entitlement(entitled=True, reason="granted")

    monkeypatch.setattr(entitlements, "check_entitlement", _yes)


@pytest.fixture
def shim(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """A fake detect(): the last complete value ≥ 1000 is an anomaly."""
    calls: list[dict] = []

    def detect(series, *, grain, sensitivity, previous, now):
        calls.append({"series": series, "grain": grain, "sensitivity": sensitivity, "previous": previous})
        points = [{**p, "expected": 10.0, "low": 5.0, "high": 15.0, "score": 0.0, "kind": "none", "partial": False,
                   "restated": False, "previous": None} for p in series]
        last = series[-1]["value"] if series else None
        status_ = "anomaly" if last is not None and last >= 1000 else "ok"
        if points and status_ == "anomaly":
            points[-1]["kind"] = "anomaly"
        summary = {"status": status_, "headline": "Spike" if status_ == "anomaly" else "Within the expected range",
                   "since": series[-1]["period"] if status_ == "anomaly" else None, "latest": None,
                   "latest_kind": None, "counts": {}, "restated": 0}
        return {"points": points, "summary": summary}

    monkeypatch.setattr(anomaly, "is_available", lambda: True)
    monkeypatch.setattr(anomaly, "detect", detect)
    monkeypatch.setattr(anomaly, "slice_values", lambda totals, limit: [t["slice"] for t in totals][:limit])
    return calls


@pytest.fixture
def batches(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Stubbed run_many: 30 days of revenue ending yesterday per query; set `respond` to override."""
    calls: list[dict] = []

    async def fake_run_many(project_id, project_path, sqls, *, limit=5000, target=None):
        calls.append({"sqls": sqls, "target": target})
        respond = state.get("respond")
        if respond is not None:
            return respond(len(calls), sqls)
        metrics = state.get("metrics") or ["revenue"] * len(sqls)
        return [_series_result(30, last=state.get("last", 10), metric=metrics[i]) for i in range(len(sqls))]

    state: dict = {}
    monkeypatch.setattr(monitors, "run_many", fake_run_many)
    calls.append(state)  # calls[0] is the state dict
    return calls


def _series_result(days: int, last: float = 10, *, region: str | None = None, metric: str = "revenue") -> BatchResult:
    today = date.today()
    rows = []
    for i in range(days, 0, -1):
        day = (today - timedelta(days=i)).isoformat()
        value = last if i == 1 else 10
        rows.append([day, region, value] if region else [day, value])
    columns = ["metric_time__day", *(["customer__region"] if region else []), metric]
    return BatchResult(columns, rows, False)


async def _settle() -> None:
    for _ in range(50):
        pending = [t for t in monitors._tasks if not t.done()]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)


async def _project(db: AsyncSession, tmp_path: Path, *, mode: str = "") -> Project:
    root = tmp_path / "proj"
    (root / "target").mkdir(parents=True)
    (root / "models").mkdir()
    (root / "dbt_project.yml").write_text("name: mf_bench\nprofile: mf_bench\n")
    shutil.copy(FIXTURES / "dbt_1_12" / "manifest.json", root / "target" / "manifest.json")
    shutil.copy(FIXTURES / "dbt_1_12" / "semantic_manifest.json", root / "target" / "semantic_manifest.json")
    shutil.copy(FIXTURES / "legacy_spec.yml", root / "models" / "semantic.yml")
    project = Project(name="mf_bench", path=str(root), platform="duckdb", metricflow_mode=mode)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    service._info_cache.clear()
    status._spec_cache.clear()
    return project


async def _monitor(db: AsyncSession, project: Project, **kw) -> MetricMonitor:
    m = MetricMonitor(project_id=project.id, metric=kw.pop("metric", "revenue"), grain=kw.pop("grain", "day"),
                      lookback=kw.pop("lookback", 180), **kw)
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return m


async def _run(project_id: int) -> MetricMonitorRun:
    async with db_engine.SessionLocal() as s:
        return (await s.execute(
            select(MetricMonitorRun).where(MetricMonitorRun.project_id == project_id).order_by(MetricMonitorRun.id.desc())
        )).scalars().first()


async def _fresh(model, pk):
    async with db_engine.SessionLocal() as s:
        return await s.get(model, pk)


# ── the job ──────────────────────────────────────────────────────────────────


async def test_refresh_stores_history_and_result(db, tmp_path, worker, shim, batches) -> None:
    project = await _project(db, tmp_path)
    a = await _monitor(db, project)
    b = await _monitor(db, project, metric="order_count", sensitivity="high")
    batches[0].update(last=5000, metrics=["revenue", "order_count"])
    queue = await bus.subscribe(f"project:{project.id}")
    try:
        run_id = await monitors.request_refresh(project.id, None, "manual")
        await _settle()
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
    finally:
        await bus.unsubscribe(f"project:{project.id}", queue)

    run = await _run(project.id)
    assert run.id == run_id and run.status == "done" and run.trigger == "manual"
    assert json.loads(run.monitors_json) == [a.id, b.id]
    results = json.loads(run.results_json)
    assert [r["status"] for r in results] == ["anomaly", "anomaly"]
    assert "recent" not in results[0]
    assert len(batches) == 2 and len(batches[1]["sqls"]) == 2  # one batch for both
    start = next(p for op, p in worker if op == "explain")["start"]
    assert start == monitors.mq.window_start(date.today(), "day", 180, has_history=False).isoformat()
    assert [c["sensitivity"] for c in shim] == ["normal", "high"]

    async with db_engine.SessionLocal() as s:
        count = (await s.execute(select(func.count()).select_from(MetricMonitorPoint))).scalar_one()
    assert count == 60
    stored = await _fresh(MetricMonitor, a.id)
    latest = json.loads(stored.last_result_json)
    assert latest["status"] == "anomaly" and len(latest["recent"]) == 30 and stored.last_checked_at

    types = [e.type for e in events]
    assert types[0] == "metric_monitor_started" and types[-1] == "metric_monitor_finished"
    assert "metric_monitor_progress" in types
    assert events[-1].data == {"run_id": run_id, "ok": True, "counts": {"anomaly": 2}}


async def test_second_refresh_uses_trailing_window_and_records_restatements(db, tmp_path, worker, shim, batches) -> None:
    project = await _project(db, tmp_path)
    m = await _monitor(db, project)
    await monitors.request_refresh(project.id, None, "manual")
    await _settle()
    # pretend those values were stored long ago (after their periods had ended)
    async with db_engine.SessionLocal() as s:
        for p in (await s.execute(select(MetricMonitorPoint))).scalars():
            p.observed_at = datetime.now(UTC) + timedelta(days=1)
        await s.commit()
    batches[0]["last"] = 99
    worker.clear()
    await monitors.request_refresh(project.id, None, "manual")
    await _settle()
    start = next(p for op, p in worker if op == "explain")["start"]
    assert start == monitors.mq.window_start(date.today(), "day", 180, has_history=True).isoformat()
    assert shim[-1]["previous"] and len(shim[-1]["previous"]) == 30
    async with db_engine.SessionLocal() as s:
        restated = (await s.execute(
            select(MetricMonitorPoint).where(MetricMonitorPoint.previous_value.is_not(None))
        )).scalars().all()
    assert [(r.value, r.previous_value) for r in restated] == [(99.0, 10.0)]
    assert m.id


async def test_one_failing_query_and_busy_lock(db, tmp_path, worker, shim, batches) -> None:
    project = await _project(db, tmp_path)
    await _monitor(db, project)
    await _monitor(db, project, metric="order_count")
    batches[0]["respond"] = lambda n, sqls: [_series_result(30), BatchResult([], [], False, "Binder Error: boom")]
    await monitors.request_refresh(project.id, None, "manual")
    await _settle()
    results = json.loads((await _run(project.id)).results_json)
    assert [r["status"] for r in results] == ["ok", "error"]
    assert results[1]["error"] == "Binder Error: boom"

    busy = "dbt stayed busy with another command for 60s"
    batches[0]["respond"] = lambda n, sqls: [BatchResult([], [], False, busy) for _ in sqls]
    await monitors.request_refresh(project.id, None, "manual")
    await _settle()
    run = await _run(project.id)
    assert run.status == "done"
    assert {r["error"] for r in json.loads(run.results_json)} == {busy}


async def test_unexpected_columns_is_a_monitor_error(db, tmp_path, worker, shim, batches) -> None:
    project = await _project(db, tmp_path)
    await _monitor(db, project)
    batches[0]["respond"] = lambda n, sqls: [BatchResult(["x"], [[1]], False)]
    await monitors.request_refresh(project.id, None, "manual")
    await _settle()
    result = json.loads((await _run(project.id)).results_json)[0]
    assert result["status"] == "error" and "unexpected columns" in result["error"]


async def test_metricflow_unavailable_fails_the_run(db, tmp_path, worker, shim, batches) -> None:
    project = await _project(db, tmp_path, mode="off")
    await _monitor(db, project)
    await monitors.request_refresh(project.id, None, "manual")
    await _settle()
    run = await _run(project.id)
    assert run.status == "error" and run.error_message
    assert len(batches) == 1  # never queried


async def test_requests_while_running_merge_into_one_follow_up(db, tmp_path, worker, shim, batches) -> None:
    project = await _project(db, tmp_path)
    a = await _monitor(db, project)
    b = await _monitor(db, project, metric="order_count")
    gate = asyncio.Event()

    async def slow_run_many(project_id, project_path, sqls, *, limit=5000, target=None):
        batches.append({"sqls": sqls})
        await gate.wait()
        return [_series_result(30, metric=m) for m in ["revenue", "order_count"][: len(sqls)]]

    monitors.run_many = slow_run_many  # restored by the monkeypatch in `batches`
    first = await monitors.request_refresh(project.id, [a.id], "build")
    await asyncio.sleep(0.05)
    assert await monitors.request_refresh(project.id, [b.id], "build") is None
    assert await monitors.request_refresh(project.id, [a.id], "manual") is None
    gate.set()
    await _settle()
    async with db_engine.SessionLocal() as s:
        runs = (await s.execute(select(MetricMonitorRun).order_by(MetricMonitorRun.id))).scalars().all()
    assert runs[0].id == first and len(runs) == 2
    assert sorted(json.loads(runs[1].monitors_json)) == sorted([a.id, b.id])
    assert project.id not in monitors.running


async def test_sliced_monitor_refreshes_top_slices_first(db, tmp_path, worker, shim, batches) -> None:
    project = await _project(db, tmp_path)
    m = await _monitor(db, project, dimension="customer__region")

    def respond(n, sqls):
        if n == 2:  # the totals batch
            return [BatchResult(["customer__region", "revenue"], [["north", 50], ["south", 20], ["a;b", 99]], False)]
        north, south = _series_result(30, last=2000, region="north"), _series_result(30, region="south")
        return [BatchResult(north.columns, north.rows + south.rows, False)]

    batches[0]["respond"] = respond
    await monitors.request_refresh(project.id, None, "manual")
    await _settle()
    stored = await _fresh(MetricMonitor, m.id)
    assert json.loads(stored.slices_json) == ["north", "south"] and stored.slices_refreshed_at
    explains = [p for op, p in worker if op == "explain"]
    assert explains[0]["group_by"] == ["customer__region"]
    assert explains[1]["where"] == ["{{ Dimension('customer__region') }} in ('north', 'south')"]
    latest = json.loads(stored.last_result_json)
    assert latest["status"] == "anomaly" and latest["worst_slice"] == "north"
    assert latest["headline"].startswith("north: ")
    assert [s["slice"] for s in latest["slices"]] == ["north", "south"]


async def test_pinned_target_runs_in_its_own_batch(db, tmp_path, worker, shim, batches) -> None:
    project = await _project(db, tmp_path)
    await _monitor(db, project)
    await _monitor(db, project, target="prod")
    await monitors.request_refresh(project.id, None, "manual")
    await _settle()
    assert [c["target"] for c in batches[1:]] == [None, "prod"]
    async with db_engine.SessionLocal() as s:
        targets = set((await s.execute(select(MetricMonitorPoint.target))).scalars())
    assert targets == {"", "prod"}


# ── triggers ─────────────────────────────────────────────────────────────────


async def test_after_run_refreshes_only_downstream_monitors(db, tmp_path, worker, shim, entitled, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    revenue = await _monitor(db, project)
    await _monitor(db, project, metric="buyers", enabled=False)
    requested: list = []

    async def fake_request(project_id, ids, trigger):
        requested.append((project_id, list(ids), trigger))

    monkeypatch.setattr(monitors, "request_refresh", fake_request)
    await monitors._after_run(project.id, Path(project.path), {"model.mf_bench.stg_orders"})
    assert requested == [(project.id, [revenue.id], "build")]
    requested.clear()
    await monitors._after_run(project.id, Path(project.path), {"model.mf_bench.dim_customers"})
    assert requested == []


async def test_after_run_without_entitlement_does_nothing(db, tmp_path, worker, shim, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    await _monitor(db, project)

    async def _no(_session, **_kw):
        return entitlements.Entitlement(entitled=False, reason="no_license")

    async def fail(*_a):
        raise AssertionError("should not refresh")

    monkeypatch.setattr(entitlements, "check_entitlement", _no)
    monkeypatch.setattr(monitors, "request_refresh", fail)
    await monitors._after_run(project.id, Path(project.path), {"model.mf_bench.stg_orders"})


async def test_interval_tick(db, tmp_path, worker, shim, entitled, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    await _monitor(db, project)
    started: list = []

    async def fake_request(project_id, ids, trigger):
        started.append((project_id, ids, trigger))

    monkeypatch.setattr(monitors, "request_refresh", fake_request)
    now = datetime.now(UTC)
    assert await monitors.tick(now) == []  # off by default
    db.add(ProjectEnvVar(project_id=project.id, key=monitors.INTERVAL_KEY, value="6"))
    await db.commit()
    assert await monitors.tick(now) == [project.id]
    assert started == [(project.id, None, "interval")]
    db.add(MetricMonitorRun(project_id=project.id, status="done", started_at=now - timedelta(hours=2)))
    await db.commit()
    assert await monitors.tick(now) == []
    assert await monitors.tick(now + timedelta(hours=5)) == [project.id]


# ── routes ───────────────────────────────────────────────────────────────────


async def test_routes_need_pro(db, tmp_path, client, monkeypatch) -> None:
    project = await _project(db, tmp_path)

    async def _no(_session, **_kw):
        return entitlements.Entitlement(entitled=False, reason="no_license")

    monkeypatch.setattr(entitlements, "check_entitlement", _no)
    res = await client.get(f"/api/projects/{project.id}/metric-monitors")
    assert res.status_code == 403 and res.json()["detail"]["error"] == "pro_feature_required"

    async def _yes(_session, **_kw):
        return entitlements.Entitlement(entitled=True, reason="granted")

    monkeypatch.setattr(entitlements, "check_entitlement", _yes)
    monkeypatch.setattr(anomaly, "is_available", lambda: False)
    assert (await client.get(f"/api/projects/{project.id}/metric-monitors")).status_code == 503


async def test_create_validates_and_starts_a_refresh(db, tmp_path, client, worker, shim, entitled, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    requested: list = []

    async def fake_request(project_id, ids, trigger):
        requested.append((list(ids), trigger))
        return 1

    monkeypatch.setattr(monitors, "request_refresh", fake_request)
    url = f"/api/projects/{project.id}/metric-monitors"
    assert (await client.post(url, json={"metric": "nope"})).status_code == 400
    assert (await client.post(url, json={"metric": "revenue", "dimension": "x__y"})).status_code == 400
    assert (await client.post(url, json={"metric": "revenue", "dimension": "metric_time"})).status_code == 400
    assert (await client.post(url, json={"metric": "revenue", "grain": "hour"})).status_code == 422

    res = await client.post(url, json={"metric": "revenue", "grain": "week", "dimension": "customer__region"})
    assert res.status_code == 201
    body = res.json()
    assert body["lookback"] == 52 and body["sensitivity"] == "normal" and body["enabled"]
    assert requested == [([body["id"]], "manual")]
    dup = await client.post(url, json={"metric": "revenue", "grain": "week", "dimension": "customer__region"})
    assert dup.status_code == 409 and dup.json()["detail"]["error"] == "duplicate_monitor"
    assert (await client.post(url, json={"metric": "revenue", "lookback": 99999})).json()["lookback"] == 730


async def test_monitor_cap(db, tmp_path, client, worker, shim, entitled) -> None:
    project = await _project(db, tmp_path)
    for i in range(monitors.mq.MAX_MONITORS):
        db.add(MetricMonitor(project_id=project.id, metric=f"m{i}", grain="day", lookback=10))
    await db.commit()
    res = await client.post(f"/api/projects/{project.id}/metric-monitors", json={"metric": "revenue"})
    assert res.status_code == 409 and res.json()["detail"]["error"] == "too_many_monitors"


async def test_list_patch_delete_and_settings(db, tmp_path, client, worker, shim, entitled) -> None:
    project = await _project(db, tmp_path)
    m = await _monitor(db, project, target="prod", last_result_json=json.dumps({"status": "ok"}))
    db.add(MetricMonitorPoint(monitor_id=m.id, target="prod", slice="", period="2026-10-01", value=1.0))
    await db.commit()
    base = f"/api/projects/{project.id}/metric-monitors"

    body = (await client.get(base)).json()
    assert body["monitors"][0]["latest"] == {"status": "ok"} and body["interval_hours"] is None
    assert body["max_monitors"] == 25 and body["running"] is False and body["last_run"] is None

    patched = (await client.patch(f"{base}/{m.id}", json={"sensitivity": "low", "enabled": False})).json()
    assert patched["sensitivity"] == "low" and not patched["enabled"] and patched["target"] == "prod"
    assert (await client.patch(f"{base}/{m.id}", json={"target": None})).json()["target"] is None

    assert (await client.put(f"{base}/settings", json={"interval_hours": 6})).json() == {"interval_hours": 6}
    assert (await client.get(base)).json()["interval_hours"] == 6
    assert (await client.put(f"{base}/settings", json={"interval_hours": 0})).status_code == 422
    await client.put(f"{base}/settings", json={"interval_hours": None})
    assert (await client.get(base)).json()["interval_hours"] is None

    assert (await client.delete(f"{base}/{m.id}")).status_code == 204
    assert (await client.delete(f"{base}/{m.id}")).status_code == 404
    async with db_engine.SessionLocal() as s:
        assert (await s.execute(select(func.count()).select_from(MetricMonitorPoint))).scalar_one() == 0


async def test_series_suppress_and_latest(db, tmp_path, client, worker, shim, entitled, batches) -> None:
    project = await _project(db, tmp_path)
    m = await _monitor(db, project)
    base = f"/api/projects/{project.id}/metric-monitors"
    assert (await client.get(f"{base}/latest")).json() is None
    res = await client.post(f"{base}/refresh", json={})
    assert res.status_code == 200 and res.json()["run_id"]
    await _settle()
    assert (await client.get(f"{base}/latest")).json()["status"] == "done"

    series = (await client.get(f"{base}/{m.id}/series")).json()
    assert len(series["points"]) == 30 and series["summary"]["status"] == "ok"
    assert series["slices"] == [] and series["restatements"] == []
    period = series["points"][0]["period"]
    ok = await client.post(f"{base}/{m.id}/points/suppress", json={"period": period})
    assert ok.status_code == 200
    assert (await client.get(f"{base}/{m.id}/series")).json()["points"][0]["suppressed"] is True
    missing = await client.post(f"{base}/{m.id}/points/suppress", json={"period": "1999-01-01"})
    assert missing.status_code == 404
    assert (await client.get(f"{base}/999/series")).status_code == 404


async def test_health_summary_includes_monitors_with_pro(db, tmp_path, client, worker, shim, entitled) -> None:
    project = await _project(db, tmp_path)
    url = f"/api/projects/{project.id}/health/summary"
    assert (await client.get(url)).json()["monitors"] is None  # no monitors yet
    latest = {"status": "anomaly", "metric": "revenue", "headline": "Spike", "target": None,
              "checked_at": "2026-10-28T10:00:00+00:00"}
    await _monitor(db, project, last_result_json=json.dumps(latest))
    body = (await client.get(url)).json()["monitors"]
    assert body["status"] == "fail" and body["headline"] == "revenue: Spike"


async def test_reorder_monitors(db, tmp_path, client, worker, shim, entitled, monkeypatch) -> None:
    project = await _project(db, tmp_path)

    async def fake_request(project_id, ids, trigger):
        return 1

    monkeypatch.setattr(monitors, "request_refresh", fake_request)
    base = f"/api/projects/{project.id}/metric-monitors"
    a = (await client.post(base, json={"metric": "revenue"})).json()
    b = (await client.post(base, json={"metric": "order_count"})).json()
    c = (await client.post(base, json={"metric": "revenue", "grain": "week"})).json()
    assert [a["position"], b["position"], c["position"]] == [0, 1, 2]

    assert (await client.put(f"{base}/order", json={"ids": [c["id"], a["id"]]})).status_code == 204
    listed = [m["id"] for m in (await client.get(base)).json()["monitors"]]
    assert listed == [c["id"], a["id"], b["id"]]  # unlisted ones keep their order after

    assert (await client.put(f"{base}/order", json={"ids": [999]})).status_code == 400
    assert (await client.put(f"{base}/order", json={"ids": [a["id"], a["id"]]})).status_code == 400
    d = (await client.post(base, json={"metric": "order_count", "grain": "week"})).json()
    assert [m["id"] for m in (await client.get(base)).json()["monitors"]][-1] == d["id"]
