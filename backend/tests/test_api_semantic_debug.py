"""POST /semantic/debug (+ cancel, reconcile, Pro explain) — plan 15 — with a stubbed worker and batch."""

import asyncio
import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project
from app.licensing import entitlements
from app.main import app
from app.semantic import debug, debug_pro, service, status
from app.semantic.batch import BatchResult
from app.semantic.execute import QueryResult
from app.semantic.query_service import MetricQueryOutcome
from tests.test_semantic_debug import EXPLAINED, MF_SQL

FIXTURES = Path(__file__).parent / "fixtures" / "semantic"
QUERY = {"metrics": ["completed_revenue"], "group_by": ["metric_time__month", "customer__region"]}


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


def _row_for(sql: str) -> list:
    if "joined_rows" in sql:
        return [[10, 18, 1, 0, 4]]  # fan-out 1.8×
    if "scope_rows" in sql:
        return [[100, 100, 80, 0, "2026-01-01", "2026-03-31"]]
    if "distinct_normalized" in sql:
        return [[4, 0, 0, 3, 3]]
    return []  # variants: none


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch) -> dict:
    rec: dict = {"runs": [], "explains": [], "block": None}

    async def fake_env():
        return "1.10.0", "3.11"

    async def fake_request(op, payload=None, *, timeout=30.0):
        if op == "catalog":
            return {"metrics": [{"name": "completed_revenue", "type": "simple", "label": "Completed revenue",
                                 "description": "Revenue of completed orders", "dimensions": []}], "saved_queries": []}
        rec["explains"].append((op, payload))
        return {**EXPLAINED, "sql": MF_SQL, "columns": ["metric_time__month", "completed_revenue"]}

    async def fake_run_many(project_id, project_path, sqls, *, limit=5000, target=None):
        rec["runs"].append(sqls)
        if rec["block"] is not None:
            await rec["block"].wait()
        return [BatchResult(["c"], _row_for(s), False) for s in sqls]

    monkeypatch.setattr(status, "dbt_environment", fake_env)
    monkeypatch.setattr(service, "dbt_environment", fake_env)
    monkeypatch.setattr(service.metricflow_runtime, "request", fake_request)
    monkeypatch.setattr(debug, "run_many", fake_run_many)
    return rec


async def _project(db: AsyncSession, tmp_path: Path) -> Project:
    root = tmp_path / "proj"
    (root / "target").mkdir(parents=True)
    (root / "dbt_project.yml").write_text("name: jaffle\nprofile: jaffle\n")
    for name in ("manifest.json", "semantic_manifest.json"):
        shutil.copy(FIXTURES / "dbt_1_12" / name, root / "target" / name)
    project = Project(name="jaffle", path=str(root))
    db.add(project)
    await db.commit()
    return project


async def test_debug_runs_every_check_in_one_batch_then_serves_them_stored(client, db, tmp_path, stubs) -> None:
    project = await _project(db, tmp_path)
    url = f"/api/projects/{project.id}/semantic/debug"
    res = await client.post(url, json={"query": QUERY})
    assert res.status_code == 200, res.text
    body = res.json()
    assert stubs["explains"][0][0] == "explain_plan"
    assert len(stubs["runs"]) == 1 and len(stubs["runs"][0]) == body["queries"] == body["ran"] == 4
    assert {n["id"]: n["step"] for n in body["plan"]}["jso_0"] == 0
    assert [s["labels"][0] for s in body["steps"]] == ["Join Standard Outputs", "Constrain Output with WHERE"]
    assert body["warnings"][0]["id"] == "join:0:fanout" and body["warnings"][0]["status"] == "fail"
    assert body["ran_at"]
    assert body["inputs"][0]["filter_sql"] == "((status) = 'completed')"

    again = (await client.post(url, json={"query": QUERY})).json()
    assert len(stubs["runs"]) == 1 and again["ran"] == 0  # stored like metric results
    assert again["warnings"] == body["warnings"]

    await client.post(url, json={"query": QUERY, "refresh": True})
    assert len(stubs["runs"]) == 2


async def test_debug_without_run_only_reads_stored_results(client, db, tmp_path, stubs) -> None:
    project = await _project(db, tmp_path)
    res = await client.post(f"/api/projects/{project.id}/semantic/debug", json={"query": QUERY, "run": False})
    assert res.status_code == 200
    assert stubs["runs"] == []
    assert {c["status"] for c in res.json()["checks"]} == {"not_run"}


async def test_debug_rejects_saved_queries_and_unknown_metrics(client, db, tmp_path, stubs) -> None:
    project = await _project(db, tmp_path)
    url = f"/api/projects/{project.id}/semantic/debug"
    res = await client.post(url, json={"query": {"saved_query": "weekly"}})
    assert res.status_code == 400 and "saved query" in res.json()["detail"]["message"]
    res = await client.post(url, json={"query": {"metrics": ["nope"]}})
    assert res.status_code == 400 and res.json()["detail"]["error"] == "invalid_query"
    assert stubs["runs"] == []


async def test_cancel_stops_the_checks(client, db, tmp_path, stubs) -> None:
    project = await _project(db, tmp_path)
    stubs["block"] = asyncio.Event()
    pending = asyncio.create_task(client.post(f"/api/projects/{project.id}/semantic/debug", json={"query": QUERY}))
    for _ in range(200):
        if stubs["runs"]:
            break
        await asyncio.sleep(0.01)
    res = await client.post(f"/api/projects/{project.id}/semantic/debug/cancel")
    assert res.json() == {"cancelled": True}
    res = await pending
    assert res.status_code == 409 and res.json()["detail"]["error"] == "cancelled"
    assert (await client.post(f"/api/projects/{project.id}/semantic/debug/cancel")).json() == {"cancelled": False}


async def test_reconcile_lists_the_differences(client, db, tmp_path, stubs, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    seen: dict = {}

    async def fake_metric(session, project, query, adapter_type, *, rows=5000, cache="refresh"):
        seen["cache"] = cache
        return MetricQueryOutcome(sql="x", sql_hash="h", columns=["customer__region", "completed_revenue"],
                                  rows=[["EU", 10], ["US", 20]], truncated=False, ran_at=datetime.now(UTC),
                                  elapsed_ms=1, target="", profile_name=None, source="cache")

    async def fake_sql(project_id, project_path, sql, adapter_type, *, limit=500):
        seen["sql"] = sql
        if sql.startswith("select 1"):
            return QueryResult(["completed_revenue"], [[1]], False)
        return QueryResult(["CUSTOMER__REGION", "COMPLETED_REVENUE"], [["EU", 10], ["US", 25]], False)

    monkeypatch.setattr(debug, "run_metric_query", fake_metric)
    monkeypatch.setattr(debug, "run_sql", fake_sql)
    url = f"/api/projects/{project.id}/semantic/debug/reconcile"
    query = {"metrics": ["completed_revenue"], "group_by": ["customer__region"]}
    res = await client.post(url, json={"query": query, "sql": "select region as customer__region, sum(amount) "
                                                              "as completed_revenue from {{ ref('orders') }} group by 1;"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert seen["cache"] == "prefer" and not seen["sql"].endswith(";")
    assert body["summary"]["different"] == 1 and body["rows"] == [["US", "different", 20, 25, -5.0]]

    res = await client.post(url, json={"query": query, "sql": "delete from orders"})
    assert res.status_code == 400
    res = await client.post(url, json={"query": query, "sql": "select 1 as completed_revenue"})
    assert res.status_code == 400 and res.json()["detail"]["error"] == "reconcile_columns"


async def test_explain_is_pro_and_needs_the_checks(client, db, tmp_path, stubs, entitled, monkeypatch) -> None:
    project = await _project(db, tmp_path)
    url = f"/api/projects/{project.id}/semantic/debug/explain"
    monkeypatch.setattr(debug_pro, "is_available", lambda: True)
    captured: dict = {}
    monkeypatch.setattr(debug_pro, "explain", lambda ctx: captured.setdefault("ctx", ctx) and {"headline": "h"})

    entitled["entitled"] = False
    res = await client.post(url, json={"query": QUERY})
    assert res.status_code == 403
    entitled["entitled"] = True
    res = await client.post(url, json={"query": QUERY})
    assert res.status_code == 409 and res.json()["detail"]["error"] == "checks_not_run"

    await client.post(f"/api/projects/{project.id}/semantic/debug", json={"query": QUERY})
    res = await client.post(url, json={"query": QUERY})
    assert res.status_code == 200 and res.json() == {"headline": "h"}
    ctx = captured["ctx"]
    assert ctx["definitions"]["completed_revenue"]["label"] == "Completed revenue"
    assert ctx["definitions"]["completed_revenue"]["inputs"][0]["expr"] == "amount"
    assert any(c["id"] == "join:0:fanout" for c in ctx["checks"]) and ctx["result"] is None
    assert len(stubs["runs"]) == 1  # explaining never runs checks
