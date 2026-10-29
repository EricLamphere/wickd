"""Semantic layer routes: status, explain/query, the Health check and the dbt-core change flow.

The MetricFlow worker and dbt are mocked; tests/test_semantic_runtime.py covers the worker.
"""

import asyncio
import json
import shutil
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project, ProjectEnvVar, SemanticCheckSnapshot
from app.dbt.runner import runner
from app.main import app
from app.semantic import dbt_change, execute, service, status
from app.semantic.runtime import WorkerRequestError

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"
SQL = "SELECT metric_time__day, SUM(amount) AS revenue FROM orders GROUP BY 1"


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'sem.sqlite'}", future=True)
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
def worker_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict]]:
    calls: list[tuple[str, dict]] = []

    async def fake_request(op: str, payload: dict | None = None, *, timeout: float = 30.0) -> dict:
        calls.append((op, payload or {}))
        if op == "explain":
            if payload.get("metrics") == ["nope"]:
                raise WorkerRequestError("invalid_query", "The given input does not exactly match any known metrics.")
            if payload.get("metrics") == ["buyers"] and payload.get("group_by"):
                raise WorkerRequestError("invalid_query", "buyers can't be grouped by metric_time")
            return {"sql": SQL, "columns": ["metric_time__day", "revenue"]}
        if op == "validate":
            return {"errors": [{"level": "error", "message": "Measure x not found", "object_type": "metric",
                                "object_name": "revenue", "element_type": None, "element_name": None}],
                    "warnings": [], "future_errors": []}
        if op == "catalog":
            return {"metrics": [{"name": "revenue", "dimensions": []}, {"name": "buyers", "dimensions": []}],
                    "saved_queries": []}
        return {}

    monkeypatch.setattr(service.metricflow_runtime, "request", fake_request)
    return calls


@pytest.fixture
def dbt_env(monkeypatch: pytest.MonkeyPatch):
    env = {"version": "1.12.6", "python": "3.12"}

    async def fake_env():
        return (env["version"], env["python"])

    monkeypatch.setattr(status, "dbt_environment", fake_env)
    monkeypatch.setattr(service, "dbt_environment", fake_env)
    return env


async def _project(db: AsyncSession, tmp_path: Path, fixture: str = "dbt_1_12", yaml: str = "legacy_spec.yml") -> Project:
    root = tmp_path / "proj"
    (root / "target").mkdir(parents=True)
    (root / "models").mkdir()
    (root / "dbt_project.yml").write_text("name: mf_bench\nprofile: mf_bench\n")
    shutil.copy(FIXTURES / fixture / "manifest.json", root / "target" / "manifest.json")
    shutil.copy(FIXTURES / fixture / "semantic_manifest.json", root / "target" / "semantic_manifest.json")
    shutil.copy(FIXTURES / yaml, root / "models" / "semantic.yml")
    project = Project(name="mf_bench", path=str(root), platform="duckdb")
    db.add(project)
    await db.commit()
    await db.refresh(project)
    service._info_cache.clear()
    status._spec_cache.clear()
    return project


# ── status ────────────────────────────────────────────────────────────────────


async def test_status_available(client, db, tmp_path, dbt_env) -> None:
    project = await _project(db, tmp_path)
    body = (await client.get(f"/api/projects/{project.id}/semantic/status")).json()
    assert body["available"] and body["can_query"]
    assert body["mode"] == "auto" and body["mode_source"] == "global"
    assert body["spec"] == "legacy"
    assert body["adapter_type"] == "duckdb"
    assert body["counts"] == {"semantic_models": 2, "metrics": 7, "saved_queries": 1}


async def test_status_latest_spec_on_old_dbt_offers_versions(client, db, tmp_path, dbt_env) -> None:
    dbt_env["version"] = "1.11.16"
    project = await _project(db, tmp_path, "dbt_1_12_latest", "latest_spec.yml")
    body = (await client.get(f"/api/projects/{project.id}/semantic/status")).json()
    assert not body["available"]
    assert body["reason_code"] == "latest_spec_needs_1_12"
    assert body["compatible_dbt_versions"] == ["1.12.6"]
    assert body["recommended_version"] == "1.12.6"


async def test_status_cli_check(client, db, tmp_path, dbt_env) -> None:
    dbt_env["version"] = "1.10.2"
    project = await _project(db, tmp_path)
    body = (await client.get(f"/api/projects/{project.id}/semantic/status?want_cli=true")).json()
    assert body["reason_code"] == "no_cli_release"
    assert body["recommended_version"] == "1.10.23"


async def test_project_and_global_mode(client, db, tmp_path, dbt_env, worker_calls) -> None:
    project = await _project(db, tmp_path)
    resp = await client.put("/api/settings", json={"metricflow_mode": "off"})
    assert resp.json()["metricflow_mode"] == "off"
    body = (await client.get(f"/api/projects/{project.id}/semantic/status")).json()
    assert (body["mode"], body["mode_source"], body["reason_code"]) == ("off", "global", "off")

    resp = await client.patch(f"/api/projects/{project.id}/settings", json={"metricflow_mode": "auto"})
    assert resp.json()["metricflow_mode"] == "auto"
    body = (await client.get(f"/api/projects/{project.id}/semantic/status")).json()
    assert (body["mode"], body["mode_source"], body["available"]) == ("auto", "project", True)

    await client.patch(f"/api/projects/{project.id}/settings", json={"metricflow_mode": "off"})
    resp = await client.post(f"/api/projects/{project.id}/semantic/explain", json={"metrics": ["revenue"]})
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "off"
    assert worker_calls == []


async def test_bad_modes_rejected(client, db, tmp_path) -> None:
    project = await _project(db, tmp_path)
    assert (await client.put("/api/settings", json={"metricflow_mode": "sometimes"})).status_code == 400
    resp = await client.patch(f"/api/projects/{project.id}/settings", json={"metricflow_mode": "maybe"})
    assert resp.status_code == 400


# ── explain / query ───────────────────────────────────────────────────────────


async def test_explain_passes_the_manifest_and_dialect(client, db, tmp_path, dbt_env, worker_calls) -> None:
    project = await _project(db, tmp_path)
    resp = await client.post(
        f"/api/projects/{project.id}/semantic/explain",
        json={"metrics": ["revenue"], "group_by": ["metric_time__day"], "limit": 10},
    )
    assert resp.status_code == 200
    assert resp.json()["sql"] == SQL
    op, payload = worker_calls[-1]
    assert op == "explain"
    assert payload["dialect"] == "duckdb"
    assert payload["manifest_path"].endswith("target/semantic_manifest.json")
    assert payload["limit"] == 10 and "start" not in payload


async def test_explain_uses_custom_target_path(client, db, tmp_path, dbt_env, worker_calls) -> None:
    project = await _project(db, tmp_path)
    root = Path(project.path)
    (root / "target").rename(root / "build")
    (root / "dbt_project.yml").write_text("name: mf_bench\ntarget-path: build\n")
    resp = await client.post(f"/api/projects/{project.id}/semantic/explain", json={"metrics": ["revenue"]})
    assert resp.status_code == 200
    assert worker_calls[-1][1]["manifest_path"].endswith("build/semantic_manifest.json")


async def test_explain_invalid_query_is_400(client, db, tmp_path, dbt_env, worker_calls) -> None:
    project = await _project(db, tmp_path)
    resp = await client.post(f"/api/projects/{project.id}/semantic/explain", json={"metrics": ["nope"]})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_query"


async def test_query_runs_through_dbt_show(client, db, tmp_path, dbt_env, worker_calls, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    seen = {}

    async def fake_env(project_id):
        return {"DBT_TARGET": "dev"}

    async def fake_run(req):
        seen["extra"] = req.extra
        rows = [{"metric_time__day": f"2024-01-0{i}", "revenue": i} for i in range(1, 4)]
        return 0, json.dumps({"show": rows}).encode(), b""

    monkeypatch.setattr(execute, "load_project_env", fake_env)
    monkeypatch.setattr(runner, "run", fake_run)
    resp = await client.post(f"/api/projects/{project.id}/semantic/query", json={"metrics": ["revenue"], "rows": 2})
    assert resp.status_code == 200
    body = resp.json()
    assert body["columns"] == ["metric_time__day", "revenue"]
    assert len(body["rows"]) == 2 and body["truncated"] is True
    assert seen["extra"][:2] == ("--inline", SQL)
    assert ("--limit", "5001") == seen["extra"][2:4]  # always the cap: the cache serves any smaller `rows`
    assert seen["extra"][-2:] == ("--target", "dev")
    assert body["source"] == "warehouse" and body["sql_hash"]


@pytest.fixture
def fake_show(monkeypatch: pytest.MonkeyPatch) -> dict:
    """dbt show returning three rows; counts calls and can block until released."""
    state = {"calls": 0, "gate": None}

    async def fake_env(project_id):
        return {"DBT_TARGET": "dev"}

    async def fake_run(req):
        state["calls"] += 1
        if state["gate"] is not None:
            await state["gate"].wait()
        rows = [{"metric_time__day": f"2024-01-0{i}", "revenue": i} for i in range(1, 4)]
        return 0, json.dumps({"show": rows}).encode(), b""

    monkeypatch.setattr(execute, "load_project_env", fake_env)
    monkeypatch.setattr(runner, "run", fake_run)
    return state


async def test_query_results_are_cached_per_sql_and_env(client, db, tmp_path, dbt_env, worker_calls, fake_show) -> None:
    project = await _project(db, tmp_path)
    url = f"/api/projects/{project.id}/semantic"
    assert (await client.post(f"{url}/query/cached", json={"metrics": ["revenue"]})).json() is None

    first = (await client.post(f"{url}/query", json={"metrics": ["revenue"]})).json()
    cached = (await client.post(f"{url}/query", json={"metrics": ["revenue"], "cache": "prefer", "rows": 1})).json()
    assert fake_show["calls"] == 1
    assert cached["source"] == "cache" and cached["rows"] == first["rows"][:1] and cached["truncated"] is True
    assert cached["sql_hash"] == first["sql_hash"] and cached["ran_at"] == first["ran_at"]
    preview = (await client.post(f"{url}/query/cached", json={"metrics": ["revenue"]})).json()
    assert preview["source"] == "cache" and len(preview["rows"]) == 3

    # A profile/project var change (e.g. a profile repointing the target) is a different env: a miss
    db.add(ProjectEnvVar(project_id=project.id, key="DBT_DATABASE", value="prod"))
    await db.commit()
    assert (await client.post(f"{url}/query/cached", json={"metrics": ["revenue"]})).json() is None
    again = (await client.post(f"{url}/query", json={"metrics": ["revenue"], "cache": "prefer"})).json()
    assert again["source"] == "warehouse" and fake_show["calls"] == 2


async def test_query_batch_reads_stored_results_and_runs_the_rest_in_one_batch(
    client, db, tmp_path, dbt_env, worker_calls, monkeypatch
) -> None:
    from app.semantic import query_batch
    from app.semantic.batch import BatchResult

    batches: list[list[str]] = []

    async def fake_run_many(project_id, project_path, sqls, *, limit=5000, target=None):
        batches.append(sqls)
        return [BatchResult(["metric_time__day", "revenue"], [["2024-01-01", 5]], False) for _ in sqls]

    monkeypatch.setattr(query_batch, "run_many", fake_run_many)
    project = await _project(db, tmp_path)
    url = f"/api/projects/{project.id}/semantic/query/batch"
    queries = [{"metrics": ["revenue"]}, {"metrics": ["nope"]}]

    stored = (await client.post(url, json={"queries": queries})).json()["results"]
    assert [r["status"] for r in stored] == ["not_run", "error"] and not batches
    assert "nope" in stored[1]["error"]

    ran = (await client.post(url, json={"queries": queries, "run": True})).json()["results"]
    assert ran[0]["status"] == "ok" and ran[0]["result"]["rows"] == [["2024-01-01", 5]]
    assert ran[0]["result"]["source"] == "warehouse" and ran[1]["status"] == "error"
    assert len(batches) == 1 and len(batches[0]) == 1

    again = (await client.post(url, json={"queries": queries[:1], "run": True})).json()["results"]
    assert again[0]["result"]["source"] == "cache" and len(batches) == 1  # stored: nothing re-run
    single = (await client.post(f"/api/projects/{project.id}/semantic/query/cached", json=queries[0])).json()
    assert single["rows"] == [["2024-01-01", 5]]  # the same cache as the explorer

    assert (await client.post(url, json={"queries": []})).status_code == 422


async def test_identical_queries_in_flight_share_one_run(client, db, tmp_path, dbt_env, worker_calls, fake_show) -> None:
    project = await _project(db, tmp_path)
    fake_show["gate"] = asyncio.Event()
    body = {"metrics": ["revenue"]}
    pending = [asyncio.create_task(client.post(f"/api/projects/{project.id}/semantic/query", json=body)) for _ in range(3)]
    for _ in range(50):
        await asyncio.sleep(0.01)
    fake_show["gate"].set()
    responses = await asyncio.gather(*pending)
    assert [r.status_code for r in responses] == [200, 200, 200]
    assert fake_show["calls"] == 1


async def test_query_rejects_unsafe_filters_before_metricflow(client, db, tmp_path, dbt_env, worker_calls) -> None:
    project = await _project(db, tmp_path)
    resp = await client.post(f"/api/projects/{project.id}/semantic/explain",
                             json={"metrics": ["revenue"], "where": ["{{ Dimension('a') }} = 1; drop table t"]})
    assert resp.status_code == 400 and resp.json()["detail"]["error"] == "invalid_query"
    assert not [c for c in worker_calls if c[0] == "explain"]
    resp = await client.post(f"/api/projects/{project.id}/semantic/explain", json={"metrics": ["unknown_metric"]})
    assert resp.status_code == 400 and "unknown metric" in resp.json()["detail"]["message"]


def test_for_dbt_show_wraps_queries_with_their_own_limit() -> None:
    assert execute.for_dbt_show("select 1 as a;", "duckdb") == "select 1 as a"
    wrapped = execute.for_dbt_show("-- comment\nselect a from t limit 5", "duckdb")
    assert wrapped.startswith("select * from (") and wrapped.endswith(") as wickd_metric_query")


# ── Health check ──────────────────────────────────────────────────────────────


async def _wait_for_check(db: AsyncSession, snapshot_id: int) -> SemanticCheckSnapshot:
    for _ in range(100):
        db.expire_all()
        snap = await db.get(SemanticCheckSnapshot, snapshot_id)
        if snap is not None and snap.status != "running":
            return snap
        await asyncio.sleep(0.02)
    raise AssertionError("check never finished")


async def test_check_stores_results_and_feeds_the_health_summary(client, db, tmp_path, dbt_env, worker_calls) -> None:
    pid = (await _project(db, tmp_path)).id
    resp = await client.post(f"/api/projects/{pid}/semantic/check", json={})
    assert resp.status_code == 200
    snap = await _wait_for_check(db, resp.json()["id"])
    assert snap.status == "done"
    assert json.loads(snap.results_json)["errors"][0]["object_name"] == "revenue"

    latest = (await client.get(f"/api/projects/{pid}/semantic/check/latest")).json()
    assert latest["results"]["warehouse"] is None
    summary = (await client.get(f"/api/projects/{pid}/health/summary")).json()
    assert summary["semantic"]["status"] == "fail"
    assert summary["semantic"]["headline"] == "1 error"


async def test_check_against_warehouse(client, db, tmp_path, dbt_env, worker_calls, monkeypatch) -> None:
    project = await _project(db, tmp_path)

    async def fake_run_sql(project_id, project_path, sql, adapter, *, limit):
        if "fail" in project_path.name:
            raise execute.ExecutionError("dbt_show_failed", "boom")
        return execute.QueryResult(columns=["revenue"], rows=[], truncated=False)

    from app.semantic import check as check_mod

    monkeypatch.setattr(check_mod, "run_sql", fake_run_sql)
    resp = await client.post(f"/api/projects/{project.id}/semantic/check", json={"warehouse": True})
    snap = await _wait_for_check(db, resp.json()["id"])
    warehouse = json.loads(snap.results_json)["warehouse"]
    assert [w["metric"] for w in warehouse] == ["revenue", "buyers"]
    assert all(w["ok"] for w in warehouse)
    explains = [p for op, p in worker_calls if op == "explain"]
    assert all(p["limit"] == 0 for p in explains)
    # by day first; a metric that can't be put on metric_time is retried without a group-by
    assert [(p["metrics"], p.get("group_by")) for p in explains] == [
        (["revenue"], ["metric_time__day"]),
        (["buyers"], ["metric_time__day"]),
        (["buyers"], None),
    ]


async def test_health_summary_hides_semantic_without_semantic_nodes(client, db, tmp_path) -> None:
    root = tmp_path / "plain"
    (root / "target").mkdir(parents=True)
    (root / "target" / "manifest.json").write_text(json.dumps({"nodes": {}, "metadata": {}}))
    project = Project(name="plain", path=str(root), platform="duckdb")
    db.add(project)
    await db.commit()
    summary = (await client.get(f"/api/projects/{project.id}/health/summary")).json()
    assert summary["semantic"] is None


# ── dbt-core change ──────────────────────────────────────────────────────────

PIP_LIST = [
    {"name": "dbt-core", "version": "1.10.2"},
    {"name": "dbt-adapters", "version": "1.16.3"},
    {"name": "dbt_duckdb", "version": "1.10.0"},
    {"name": "requests", "version": "2.32.0"},
]
REPORT = {"install": [
    {"metadata": {"name": "dbt-core", "version": "1.10.23"}},
    {"metadata": {"name": "dbt-adapters", "version": "1.24.5"}},
    {"metadata": {"name": "dbt-duckdb", "version": "1.10.0"}},
    {"metadata": {"name": "dbt-metricflow", "version": "0.13.0"}},
]}


@pytest.fixture
def pip_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, ...]]:
    calls: list[tuple[str, ...]] = []

    async def fake_pip(*args: str, timeout: float = 0) -> tuple[int, str, str]:
        calls.append(args)
        if args[0] == "list":
            return 0, json.dumps(PIP_LIST), ""
        if "dbt-core==1.10.3" in args:
            return 1, "", "ERROR: Cannot install dbt-metricflow because these package versions have conflicting dependencies.\nResolutionImpossible"
        return 0, "Would install ...\n" + json.dumps(REPORT), ""

    monkeypatch.setattr(dbt_change, "_pip", fake_pip)
    return calls


async def test_plan_reports_the_diff_and_undoing_pins(client, db, tmp_path, pip_calls) -> None:
    project = await _project(db, tmp_path)
    reqs = tmp_path / "requirements.txt"
    reqs.write_text("dbt-core==1.10.2\ndbt-duckdb\n")
    await client.put("/api/settings", json={"global_requirements_path": str(reqs)})

    resp = await client.post(
        f"/api/projects/{project.id}/metricflow/plan-dbt-change", json={"version": "1.10.23", "want_cli": True}
    )
    body = resp.json()
    assert body["ok"] is True
    assert body["previous_version"] == "1.10.2"
    assert body["install"] == ["dbt-core==1.10.23", "dbt-duckdb", "dbt-metricflow"]
    assert body["changes"] == [
        {"name": "dbt-core", "before": "1.10.2", "after": "1.10.23", "change": "upgrade"},
        {"name": "dbt-adapters", "before": "1.16.3", "after": "1.24.5", "change": "upgrade"},
        {"name": "dbt-metricflow", "before": None, "after": "0.13.0", "change": "install"},
    ]
    assert body["pins"] == [{"source": "global", "path": str(reqs), "line": 1, "text": "dbt-core==1.10.2",
                             "spec": "==1.10.2", "exact": True}]
    assert pip_calls[-1][:5] == ("install", "--dry-run", "--quiet", "--report", "-")


async def test_plan_resolution_error(client, db, tmp_path, pip_calls) -> None:
    project = await _project(db, tmp_path)
    resp = await client.post(
        f"/api/projects/{project.id}/metricflow/plan-dbt-change", json={"version": "1.10.3", "want_cli": True}
    )
    body = resp.json()
    assert body["ok"] is False and "conflicting dependencies" in body["error"]


async def test_plan_rejects_bad_versions(client, db, tmp_path) -> None:
    project = await _project(db, tmp_path)
    resp = await client.post(f"/api/projects/{project.id}/metricflow/plan-dbt-change", json={"version": "1.10; rm"})
    assert resp.status_code == 422


async def test_apply_updates_pins_and_installs(client, db, tmp_path, pip_calls, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    reqs = tmp_path / "requirements.txt"
    reqs.write_text("dbt-core==1.10.2\n")
    await client.put("/api/settings", json={"global_requirements_path": str(reqs)})
    started = {}

    async def fake_install(args, session):
        started["args"] = args

    from app.api import init

    monkeypatch.setattr(init, "start_global_install", fake_install)
    resp = await client.post(
        f"/api/projects/{project.id}/metricflow/apply-dbt-change", json={"version": "1.10.23", "update_pins": True}
    )
    body = resp.json()
    assert body["previous_version"] == "1.10.2"
    assert started["args"] == ["dbt-core==1.10.23", "dbt-duckdb"]
    assert body["pins_updated"] == [{"source": "global", "path": str(reqs), "lines": [1]}]
    assert reqs.read_text() == "dbt-core==1.10.23\n"


async def test_apply_refuses_while_busy(client, db, tmp_path, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    monkeypatch.setattr(runner, "is_busy", lambda: True)
    resp = await client.post(f"/api/projects/{project.id}/metricflow/apply-dbt-change", json={"version": "1.10.23"})
    assert resp.status_code == 409
    assert "dbt command is running" in resp.json()["detail"]["message"]


async def test_verify_parses_and_rechecks(client, db, tmp_path, dbt_env, monkeypatch) -> None:
    project = await _project(db, tmp_path)

    async def fake_env(project_id):
        return {}

    async def fake_run(req):
        assert req.command == "parse"
        return 1, b"Could not render {{ Dimension('x') }}: 'Dimension' is undefined", b""

    from app.api import init

    monkeypatch.setattr(init, "load_project_env", fake_env)
    monkeypatch.setattr(runner, "run", fake_run)
    body = (await client.post(f"/api/projects/{project.id}/metricflow/verify-dbt-change")).json()
    assert body["dbt_core"] == "1.12.6"
    assert body["parse_ok"] is False and body["latest_spec_parse_error"] is True
    assert body["status"]["available"] is True


async def test_health_summary_shows_a_latest_spec_project_that_cannot_parse(client, db, tmp_path, dbt_env) -> None:
    dbt_env["version"] = "1.11.16"
    pid = (await _project(db, tmp_path, "dbt_1_12_latest", "latest_spec.yml")).id
    # dbt 1.11 can't parse the latest spec, so the manifest has no semantic nodes
    manifest = Path(tmp_path / "proj" / "target" / "manifest.json")
    data = json.loads(manifest.read_text())
    manifest.write_text(json.dumps({**data, "semantic_models": {}, "metrics": {}, "saved_queries": {}}))
    service._info_cache.clear()
    summary = (await client.get(f"/api/projects/{pid}/health/summary")).json()
    assert summary["semantic"]["status"] == "warn"
    assert "1.12" in summary["semantic"]["headline"]


async def test_yaml_change_forgets_the_detected_spec(tmp_path) -> None:
    from app.semantic import autoparse

    status._spec_cache[str(tmp_path)] = (1.0, "legacy")
    autoparse.schedule(99, tmp_path, delay=60)
    assert str(tmp_path) not in status._spec_cache
    autoparse.cancel_all()


# ── Save as saved query ───────────────────────────────────────────────────────


async def test_save_as_saved_query_appends_to_the_saved_queries_file(client, db, tmp_path, dbt_env, worker_calls) -> None:
    project = await _project(db, tmp_path)
    resp = await client.post(f"/api/projects/{project.id}/semantic/saved-queries", json={
        "name": "revenue_weekly", "label": "Revenue weekly", "metrics": ["revenue"],
        "group_by": ["metric_time__week"], "start": "2024-01-01",
    })
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"path": "models/semantic.yml"}
    text = (Path(project.path) / "models" / "semantic.yml").read_text()
    assert "  - name: revenue_weekly\n" in text
    assert "TimeDimension('metric_time', 'week')" in text
    assert "{{ TimeDimension('metric_time', 'day') }} >= '2024-01-01'" in text


@pytest.mark.parametrize("body, code", [
    ({"name": "Bad Name", "metrics": ["revenue"]}, 422),
    ({"name": "q", "metrics": ["revenue"], "where": ["1 = 1; drop table t"]}, 400),
    ({"name": "q", "metrics": ["revenue"], "start": "yesterday'; --"}, 422),
])
async def test_save_as_saved_query_validates(client, db, tmp_path, dbt_env, worker_calls, body, code) -> None:
    project = await _project(db, tmp_path)
    before = (Path(project.path) / "models" / "semantic.yml").read_text()
    resp = await client.post(f"/api/projects/{project.id}/semantic/saved-queries", json=body)
    assert resp.status_code == code
    assert (Path(project.path) / "models" / "semantic.yml").read_text() == before


def test_choose_file_prefers_the_saved_queries_file() -> None:
    from app.semantic.saved_queries import choose_file

    manifest = {
        "metadata": {"project_name": "p"},
        "saved_queries": {"a": {"original_file_path": "models/sq.yml", "package_name": "p"},
                          "b": {"original_file_path": "dbt_packages/x/sq.yml", "package_name": "x"}},
        "metrics": {"m": {"name": "revenue", "original_file_path": "models/metrics.yml", "package_name": "p"}},
    }
    assert choose_file(manifest, ["revenue"]) == "models/sq.yml"
    assert choose_file({**manifest, "saved_queries": {}}, ["revenue"]) == "models/metrics.yml"


async def test_profiles_yml_change_is_a_different_cache_env(client, db, tmp_path, dbt_env, worker_calls, fake_show) -> None:
    project = await _project(db, tmp_path)
    profiles = Path(project.path) / "profiles.yml"
    profiles.write_text("mf_bench:\n  target: dev\n  outputs:\n    dev: {type: duckdb, path: a.duckdb}\n")
    url = f"/api/projects/{project.id}/semantic"
    await client.post(f"{url}/query", json={"metrics": ["revenue"]})
    assert (await client.post(f"{url}/query/cached", json={"metrics": ["revenue"]})).json() is not None
    profiles.write_text("mf_bench:\n  target: dev\n  outputs:\n    dev: {type: duckdb, path: prod.duckdb}\n")
    assert (await client.post(f"{url}/query/cached", json={"metrics": ["revenue"]})).json() is None


async def test_failed_run_without_a_waiter_is_logged(monkeypatch) -> None:
    from app.semantic import query_service
    from app.semantic.query_cache import CacheKey

    logged = []
    monkeypatch.setattr(query_service.log, "warning", lambda event, **kw: logged.append((event, kw)))
    key = CacheKey(1, "", "fp", "abc")

    async def boom():
        raise RuntimeError("warehouse down")

    task = asyncio.create_task(boom())
    query_service._inflight[key] = task
    await asyncio.sleep(0)
    query_service._finished(key, task)
    assert key not in query_service._inflight
    assert logged and "warehouse down" in logged[0][1]["error"]
