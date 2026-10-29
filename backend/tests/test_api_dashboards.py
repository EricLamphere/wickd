"""Dashboard routes: files CRUD, cached results, batch refresh (run_many stubbed), Register
as exposure, and the dashboard export. The MetricFlow worker is faked."""

import shutil
from pathlib import Path

import pytest
import yaml
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project, ProjectEnvVar
from app.events.bus import bus
from app.main import app
from app.semantic import dashboard_refresh, service, status
from app.semantic.batch import BatchResult

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"
DIMENSIONS = [
    {"name": "customer__region", "type": "categorical", "time_granularity": None},
    {"name": "metric_time__day", "type": "time", "time_granularity": "day"},
]
WIDGETS = [
    {"id": "rev", "type": "timeseries", "width": 66.67, "height": 300, "metrics": ["revenue"]},
    {"id": "orders", "type": "summary", "width": 33.33, "height": 140, "metrics": ["order_count"], "options": {"trend": False}},
    {"id": "gone", "type": "table", "metrics": ["deleted_metric"]},
]


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'dash.sqlite'}", future=True)
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
            name = "_".join(payload.get("metrics") or [])
            when = (payload.get("start") or "all").replace("-", "")
            by = "_".join(payload.get("group_by") or []) or "total"
            return {"sql": f"SELECT 1 AS {name}_{by}_{when}", "columns": [name]}
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
def batches(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    calls: list[list[str]] = []

    async def fake_run_many(project_id, project_path, sqls, *, limit=5000, target=None):
        calls.append(sqls)
        return [BatchResult([], [], False, "Database Error: boom") if "order_count" in s
                else BatchResult(["revenue"], [[42]], False) for s in sqls]

    monkeypatch.setattr(dashboard_refresh, "run_many", fake_run_many)
    return calls


async def _project(db: AsyncSession, tmp_path: Path) -> Project:
    root = tmp_path / "proj"
    (root / "target").mkdir(parents=True)
    (root / "models").mkdir()
    (root / "dbt_project.yml").write_text("name: mf_bench\nprofile: mf_bench\n")
    shutil.copy(FIXTURES / "dbt_1_12" / "manifest.json", root / "target" / "manifest.json")
    shutil.copy(FIXTURES / "dbt_1_12" / "semantic_manifest.json", root / "target" / "semantic_manifest.json")
    shutil.copy(FIXTURES / "legacy_spec.yml", root / "models" / "semantic.yml")
    project = Project(name="mf_bench", path=str(root), platform="duckdb")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    service._info_cache.clear()
    status._spec_cache.clear()
    return project


async def _create(client: AsyncClient, project: Project, widgets: list[dict] | None = None) -> dict:
    res = await client.post(f"/api/projects/{project.id}/dashboards", json={"title": "Revenue overview", "widgets": widgets or WIDGETS})
    assert res.status_code == 201, res.text
    return res.json()


# ── files ────────────────────────────────────────────────────────────────────


async def test_crud(db, client, tmp_path) -> None:
    project = await _project(db, tmp_path)
    base = f"/api/projects/{project.id}/dashboards"
    assert (await client.get(base)).json() == {"folder": "wickd/dashboards", "dashboards": []}
    queue = await bus.subscribe(f"project:{project.id}")
    try:
        created = await _create(client, project)
        event = queue.get_nowait()
    finally:
        await bus.unsubscribe(f"project:{project.id}", queue)
    assert event.type == "dashboards_changed" and event.data == {"slug": "revenue-overview"}
    assert created["slug"] == "revenue-overview" and created["widget_count"] == 3
    file = Path(project.path) / "wickd" / "dashboards" / "revenue-overview.yml"
    written = yaml.safe_load(file.read_text())
    assert written["widgets"][0] == WIDGETS[0]
    assert written["period"] == {"current": "last_30_days", "compare": "previous_period"}

    listed = (await client.get(base)).json()["dashboards"]
    assert [d["slug"] for d in listed] == ["revenue-overview"]

    edited = {**created["dashboard"], "widgets": created["dashboard"]["widgets"][::-1], "extra": {"keep": True}}
    res = await client.put(f"{base}/revenue-overview", json={"dashboard": edited, "base_modified_at": created["modified_at"]})
    assert res.status_code == 200, res.text
    assert [w["id"] for w in res.json()["dashboard"]["widgets"]] == ["gone", "orders", "rev"]
    assert res.json()["dashboard"]["extra"] == {"keep": True}

    stale = await client.put(f"{base}/revenue-overview", json={"dashboard": edited, "base_modified_at": "2000-01-01T00:00:00+00:00"})
    assert stale.status_code == 409 and stale.json()["detail"]["error"] == "conflict"
    bad = await client.put(f"{base}/revenue-overview", json={"dashboard": {**edited, "widgets": [{"id": "x", "width": 500}]}})
    assert bad.status_code == 400 and "widgets.0" in bad.json()["detail"]["message"]
    assert (await client.get(f"{base}/..%2Fsecrets")).status_code in (400, 404)

    assert (await client.delete(f"{base}/revenue-overview")).status_code == 204
    assert (await client.get(f"{base}/revenue-overview")).status_code == 404


async def test_custom_folder_and_broken_file_listed(db, client, tmp_path) -> None:
    project = await _project(db, tmp_path)
    db.add(ProjectEnvVar(project_id=project.id, key="DASHBOARDS_PATH", value="boards"))
    await db.commit()
    folder = Path(project.path) / "boards"
    folder.mkdir()
    (folder / "broken.yml").write_text("title: [")
    body = (await client.get(f"/api/projects/{project.id}/dashboards")).json()
    assert body["folder"] == "boards"
    assert body["dashboards"][0]["slug"] == "broken" and "YAML" in body["dashboards"][0]["error"]
    res = await client.get(f"/api/projects/{project.id}/dashboards/broken/results")
    assert res.status_code == 422


# ── results ──────────────────────────────────────────────────────────────────


async def test_list_names_the_metrics_each_dashboard_uses(db, client, tmp_path) -> None:
    project = await _project(db, tmp_path)
    await _create(client, project, WIDGETS)
    listed = (await client.get(f"/api/projects/{project.id}/dashboards")).json()["dashboards"]
    assert listed[0]["metrics"] == ["deleted_metric", "order_count", "revenue"]


async def test_results_then_refresh(db, client, tmp_path, worker, batches) -> None:
    project = await _project(db, tmp_path)
    await _create(client, project, [*WIDGETS, {"id": "rev_again", "type": "timeseries", "metrics": ["revenue"]},
                                    {"id": "note", "type": "text", "options": {"body": "# Hi"}},
                                    {"id": "blank", "type": "bar"}])
    base = f"/api/projects/{project.id}/dashboards/revenue-overview"

    before = {w["widget_id"]: w for w in (await client.get(f"{base}/results")).json()["widgets"]}
    assert {k: w["status"] for k, w in before.items()} == {
        "rev": "not_run", "orders": "not_run", "gone": "error", "rev_again": "not_run", "note": "ok", "blank": "empty"}
    assert "deleted_metric" in before["gone"]["error"]
    assert set(before["rev"]["queries"]) == {"current", "current_previous"}
    assert before["rev"]["current"] and before["rev"]["previous"] and before["rev"]["grain"] == "day"
    assert not batches

    res = await client.post(f"{base}/refresh", json={})
    assert res.status_code == 200, res.text
    widgets = {w["widget_id"]: w for w in res.json()["widgets"]}
    assert widgets["rev"]["status"] == "ok" and widgets["rev"]["queries"]["current"]["rows"] == [[42]]
    assert widgets["rev"]["ran_at"]
    assert widgets["orders"]["status"] == "error" and "boom" in widgets["orders"]["error"]
    assert len(batches) == 1 and len(batches[0]) == 4  # rev ×2 (shared with rev_again), orders total ×2

    after = {w["widget_id"]: w for w in (await client.get(f"{base}/results")).json()["widgets"]}
    assert after["rev"]["status"] == "ok" and after["rev_again"]["queries"]["current"]["rows"] == [[42]]
    assert after["orders"]["status"] == "not_run"

    only = await client.post(f"{base}/refresh", json={"widget_ids": ["rev"]})
    assert [w["widget_id"] for w in only.json()["widgets"]] == ["rev"]


async def test_preview_runs_unsaved_widgets_in_the_dashboard_context(db, client, tmp_path, worker, batches) -> None:
    project = await _project(db, tmp_path)
    await _create(client, project, WIDGETS[:1])
    base = f"/api/projects/{project.id}/dashboards/revenue-overview"
    where = "{{ Dimension('customer__region') }} = 'north'"
    draft = {"id": "drill", "type": "timeseries", "metrics": ["revenue"], "filters": [where]}

    cached = await client.post(f"{base}/preview", json={"widgets": [draft], "run": False})
    assert cached.status_code == 200, cached.text
    assert [w["status"] for w in cached.json()["widgets"]] == ["not_run"] and not batches

    ran = await client.post(f"{base}/preview", json={"widgets": [draft]})
    widget = ran.json()["widgets"][0]
    assert widget["widget_id"] == "drill" and widget["status"] == "ok"
    assert widget["queries"]["current"]["query"]["where"] == [where]
    assert len(batches) == 1

    again = await client.post(f"{base}/preview", json={"widgets": [draft]})
    assert again.json()["widgets"][0]["status"] == "ok" and len(batches) == 1  # stored: nothing re-run
    saved = (await client.get(base)).json()["dashboard"]["widgets"]
    assert [w["id"] for w in saved] == [WIDGETS[0]["id"]]  # never written to the file

    bad = await client.post(f"{base}/preview", json={"widgets": [{"id": "Bad Id!", "type": "summary"}]})
    assert bad.status_code == 400


async def test_explore_preview_needs_no_dashboard(db, client, tmp_path, worker, batches) -> None:
    project = await _project(db, tmp_path)
    url = f"/api/projects/{project.id}/semantic/widget/preview"
    widget = {"id": "explore", "type": "timeseries", "metrics": ["revenue"],
              "period": {"current": {"start": "2026-01-01", "end": "2026-01-31"}, "compare": "none"}}

    stored = (await client.post(url, json={"widget": widget, "run": False})).json()
    assert stored["widget"]["status"] == "not_run" and not batches

    ran = (await client.post(url, json={"widget": widget})).json()["widget"]
    assert ran["status"] == "ok" and set(ran["queries"]) == {"current"}  # its own period: no comparison
    assert ran["queries"]["current"]["query"]["start"] == "2026-01-01" and len(batches) == 1

    await client.post(url, json={"widget": widget})
    assert len(batches) == 1  # stored: not run again
    await client.post(url, json={"widget": widget, "refresh": True})
    assert len(batches) == 2  # Refresh runs it anyway

    assert (await client.post(url, json={"widget": {"id": "Bad Id!"}})).status_code == 400


async def test_dashboard_period_and_filters_reach_the_explain(db, client, tmp_path, worker, batches) -> None:
    project = await _project(db, tmp_path)
    created = await _create(client, project, WIDGETS[:1])
    where = "{{ Dimension('customer__region') }} = 'north'"
    dashboard = {**created["dashboard"], "period": {"current": {"start": "2026-01-01", "end": "2026-01-31"}, "compare": "none"},
                 "filters": [where]}
    await client.put(f"/api/projects/{project.id}/dashboards/revenue-overview", json={"dashboard": dashboard})
    await client.get(f"/api/projects/{project.id}/dashboards/revenue-overview/results")
    explains = [p for op, p in worker if op == "explain"]
    assert explains[-1]["where"] == [where] and explains[-1]["start"] == "2026-01-01" and explains[-1]["end"] == "2026-01-31"


async def test_dimension_values(db, client, tmp_path, worker, monkeypatch) -> None:
    from app.semantic import query_service
    from app.semantic.execute import QueryResult

    async def fake_run_sql(project_id, path, sql, adapter_type, *, limit):
        return QueryResult(["customer__region", "revenue"], [["north", 9], ["south", 3], [None, 1]], False)

    monkeypatch.setattr(query_service, "run_sql", fake_run_sql)
    project = await _project(db, tmp_path)
    res = await client.post(f"/api/projects/{project.id}/semantic/dimension-values",
                            json={"metric": "revenue", "dimension": "customer__region"})
    assert res.status_code == 200, res.text
    assert res.json()["values"] == ["north", "south"]
    explain = [p for op, p in worker if op == "explain"][-1]
    assert explain["group_by"] == ["customer__region"] and explain["order_by"] == ["-revenue"]


# ── exposure ─────────────────────────────────────────────────────────────────


async def test_register_exposure(db, client, tmp_path, worker) -> None:
    project = await _project(db, tmp_path)
    await _create(client, project)
    res = await client.post(f"/api/projects/{project.id}/dashboards/revenue-overview/exposure", json={"owner": "Data team"})
    assert res.status_code == 200, res.text
    assert res.json() == {"path": "models/exposures.yml", "name": "revenue_overview"}
    written = yaml.safe_load((Path(project.path) / "models" / "exposures.yml").read_text())
    exposure = written["exposures"][0]
    assert exposure["type"] == "dashboard" and exposure["owner"] == {"name": "Data team"}
    assert exposure["depends_on"] == ["metric('revenue')", "metric('order_count')"]
    detail = (await client.get(f"/api/projects/{project.id}/dashboards/revenue-overview")).json()
    assert detail["exposure"] == "revenue_overview"

    again = await client.post(f"/api/projects/{project.id}/dashboards/revenue-overview/exposure", json={"owner": "x"})
    assert again.status_code == 422


async def test_propose_exposure_writes_nothing_until_accepted(db, client, tmp_path, worker) -> None:
    project = await _project(db, tmp_path)
    await _create(client, project)
    base = f"/api/projects/{project.id}"
    res = await client.post(f"{base}/dashboards/revenue-overview/exposure/propose", json={"owner": "Data team"})
    assert res.status_code == 200, res.text
    proposal = res.json()
    assert proposal["kind"] == "exposure" and proposal["status"] == "ready"
    files = {f["path"]: f for f in proposal["files"]}
    assert set(files) == {"models/exposures.yml", "wickd/dashboards/revenue-overview.yml"}
    assert files["models/exposures.yml"]["op"] == "create"
    assert "metric('revenue')" in files["models/exposures.yml"]["proposed_text"]
    assert "exposure: revenue_overview" in files["wickd/dashboards/revenue-overview.yml"]["proposed_text"]
    assert not (Path(project.path) / "models" / "exposures.yml").exists()

    accepted = await client.post(f"{base}/ai/proposals/{proposal['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "applied"
    assert yaml.safe_load((Path(project.path) / "models" / "exposures.yml").read_text())["exposures"][0]["name"] == "revenue_overview"
    detail = (await client.get(f"{base}/dashboards/revenue-overview")).json()
    assert detail["exposure"] == "revenue_overview"


async def test_exposure_status_follows_the_manifest(db, client, tmp_path, worker) -> None:
    import json as _json

    project = await _project(db, tmp_path)
    await _create(client, project)
    base = f"/api/projects/{project.id}/dashboards/revenue-overview"
    created = (await client.get(base)).json()
    linked = {**created["dashboard"], "exposure": "revenue_overview"}
    await client.put(base, json={"dashboard": linked})
    manifest_path = Path(project.path) / "target" / "manifest.json"
    manifest = _json.loads(manifest_path.read_text())
    manifest["exposures"] = {}
    manifest_path.write_text(_json.dumps(manifest))
    detail = (await client.get(base)).json()
    assert detail["exposure"] == "revenue_overview" and detail["exposure_status"] == "missing"
    listed = (await client.get(f"/api/projects/{project.id}/dashboards")).json()["dashboards"][0]
    assert listed["exposure_status"] == "missing"

    # registering again: only the exposure YAML changes (the dashboard is already linked)
    proposal = (await client.post(f"{base}/exposure/propose", json={"owner": "x"})).json()
    assert [f["path"] for f in proposal["files"]] == ["models/exposures.yml"]

    manifest["exposures"] = {"exposure.mf_bench.revenue_overview": {
        "name": "revenue_overview", "original_file_path": "models/exposures.yml",
        "depends_on": {"nodes": ["metric.mf_bench.revenue", "metric.mf_bench.order_count"]}}}
    manifest_path.write_text(_json.dumps(manifest))
    detail = (await client.get(base)).json()
    assert detail["exposure_status"] == "found" and detail["exposure_path"] == "models/exposures.yml"
    assert detail["exposure_unique_id"] == "exposure.mf_bench.revenue_overview"
    assert detail["exposure_drift"] == {"add": [], "remove": []}

    # a new metric on the dashboard: the exposure is out of date, and an update is proposed
    (Path(project.path) / "models" / "exposures.yml").write_text(
        "version: 2\nexposures:\n  - name: revenue_overview\n    type: dashboard\n    owner:\n      name: x\n"
        "    depends_on:\n      - ref('orders')\n      - metric('revenue')\n      - metric('order_count')\n")
    more = {**linked, "widgets": [*linked["widgets"], {"id": "aov", "type": "summary", "metrics": ["avg_order_value"]}]}
    detail = (await client.put(base, json={"dashboard": more})).json()
    assert detail["exposure_status"] == "out_of_date" and detail["exposure_drift"] == {"add": ["avg_order_value"], "remove": []}
    update = (await client.post(f"{base}/exposure/update")).json()
    assert update["kind"] == "exposure" and update["status"] == "ready"
    text = update["files"][0]["proposed_text"]
    assert "- ref('orders')" in text and "- metric('avg_order_value')" in text
    assert not (Path(project.path) / "models" / "exposures.yml").read_text().count("avg_order_value")

    unlinked = {k: v for k, v in linked.items() if k != "exposure"}
    detail = (await client.put(base, json={"dashboard": unlinked})).json()
    assert detail["exposure"] is None and detail["exposure_status"] is None


async def test_unlink_and_delete_exposure_is_reviewed(db, client, tmp_path, worker) -> None:
    import json as _json

    project = await _project(db, tmp_path)
    await _create(client, project)
    base = f"/api/projects/{project.id}"
    created = (await client.post(f"{base}/dashboards/revenue-overview/exposure/propose", json={"owner": "x"})).json()
    await client.post(f"{base}/ai/proposals/{created['id']}/accept", json={})
    manifest_path = Path(project.path) / "target" / "manifest.json"
    manifest = _json.loads(manifest_path.read_text())
    manifest["exposures"] = {"exposure.mf_bench.revenue_overview": {"name": "revenue_overview", "original_file_path": "models/exposures.yml",
                                                                    "depends_on": {"nodes": []}}}
    manifest_path.write_text(_json.dumps(manifest))

    res = await client.post(f"{base}/dashboards/revenue-overview/exposure/delete")
    assert res.status_code == 200, res.text
    files = {f["path"]: f for f in res.json()["files"]}
    assert files["models/exposures.yml"]["op"] == "delete"  # it was the only thing in the file
    assert "exposure:" not in files["wickd/dashboards/revenue-overview.yml"]["proposed_text"]
    assert (Path(project.path) / "models" / "exposures.yml").exists()  # nothing written yet

    accepted = await client.post(f"{base}/ai/proposals/{res.json()['id']}/accept", json={})
    assert accepted.status_code == 200 and accepted.json()["status"] == "applied"
    assert not (Path(project.path) / "models" / "exposures.yml").exists()
    assert (await client.get(f"{base}/dashboards/revenue-overview")).json()["exposure"] is None

    missing = await client.post(f"{base}/dashboards/revenue-overview/exposure/delete")
    assert missing.status_code == 409


# ── export ───────────────────────────────────────────────────────────────────


async def test_export_dashboard(db, client, tmp_path) -> None:
    project = await _project(db, tmp_path)
    out = tmp_path / "out"
    out.mkdir()
    res = await client.post(f"/api/projects/{project.id}/exports/dashboard", json={
        "directory": str(out), "filename": "revenue", "format": "html", "content": "<!doctype html>"})
    assert res.status_code == 201
    assert (out / "revenue.html").read_text() == "<!doctype html>"
