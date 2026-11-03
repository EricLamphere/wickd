"""Contract checks (plan 05): gating, the background job (change set → compile both sides →
types → wickd_pro), notes when the base can't be compiled, events, and the public helpers.
Git, dbt and the Pro check are faked."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api import contracts as api
from app.api.impact import ChangeSet
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, ColumnLineageSnapshot, MetricMonitor, Project
from app.dbt import contract_types, contracts
from app.dbt.changes import ChangeMapping
from app.dbt.contract_usage import dashboards_by_metric, semantic_consumers
from app.dbt.revisions import RevisionError, SideManifest
from app.events.bus import bus
from app.licensing import entitlements
from app.main import app

DIM = "model.proj.dim_customers"
SEED = "seed.proj.countries"
PKG = "model.other.thing"


def _manifest(sql: str = "select 1 as id") -> dict:
    return {
        "metadata": {"project_name": "proj"},
        "nodes": {
            DIM: {"name": "dim_customers", "resource_type": "model", "package_name": "proj", "compiled_code": sql},
            SEED: {"name": "countries", "resource_type": "seed", "package_name": "proj"},
            PKG: {"name": "thing", "resource_type": "model", "package_name": "other"},
        },
    }


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'c.sqlite'}", future=True)
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
    (path / "target" / "manifest.json").write_text(json.dumps(_manifest()))
    p = Project(name="proj", path=str(path))
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    return p


@pytest.fixture
def faked(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    """Change set, compiles, types and the Pro check faked; calls recorded."""
    calls: dict = {"compile": [], "check": [], "types": []}

    async def change_set(project, scope, base):
        mapping = ChangeMapping(nodes={DIM: (), SEED: (), PKG: ()}, unmapped=(), project_wide=(), relevant_files=3)
        return ChangeSet("feature", "main" if scope == "branch" else None,
                             "f" * 40 if scope == "branch" else None, mapping, True)

    async def compiled(project, *, ref, select, target=None):
        calls["compile"].append((ref, select))
        out = tmp_path / f"compiled-{ref or 'working'}.json"
        out.write_text(json.dumps(_manifest("select 1 as id, 2 as name" if ref is None else "select 1 as id")))
        return SideManifest(out, None if ref is None else "a" * 40, None, ("packages differ",) if ref else ())

    def check(head, base, uids, lineage, row_deps, consumers, types):
        calls["check"].append({"head": head, "base": base, "uids": uids, "lineage": lineage,
                               "consumers": consumers, "types": types})
        return [{"unique_id": DIM, "name": "dim_customers", "severity": "error", "breaking_changes": []}]

    async def probe(project_id, project_path, queries, env, target):
        calls["types"].append(sorted(queries))
        return {k: {"id": "integer"} for k in queries}, {}

    async def env(project_id):
        return {"DBT_TARGET": "dev"}

    monkeypatch.setattr(api, "load_change_set", change_set)
    monkeypatch.setattr(api, "compiled_manifest", compiled)
    monkeypatch.setattr(api, "load_project_env", env)
    monkeypatch.setattr(contract_types, "probe_query_types", probe)
    monkeypatch.setattr(contracts, "_pro", lambda: SimpleNamespace(check_contracts=check))
    _entitle(monkeypatch)
    return calls


async def _wait(project_id: int) -> None:
    await asyncio.wait_for(api._running[project_id], timeout=5)


async def test_routes_are_gated(client, project, monkeypatch) -> None:
    _entitle(monkeypatch, entitled=False)
    resp = await client.post(f"/api/projects/{project.id}/impact/contracts", json={"scope": "working"})
    assert resp.status_code == 403 and resp.json()["detail"]["error"] == "pro_feature_required"
    assert (await client.get(f"/api/projects/{project.id}/impact/contracts")).status_code == 403

    _entitle(monkeypatch)

    def missing():
        raise contracts.ContractsUnavailable(contracts.UNAVAILABLE)

    monkeypatch.setattr(contracts, "_pro", missing)
    assert (await client.get(f"/api/projects/{project.id}/impact/contracts")).status_code == 503


async def test_working_check_compiles_both_sides_and_stores_results(client, project, faked) -> None:
    queue = await bus.subscribe(f"project:{project.id}")
    try:
        resp = await client.post(f"/api/projects/{project.id}/impact/contracts", json={"scope": "working"})
        assert resp.status_code == 202 and resp.json()["status"] == "running"
        await _wait(project.id)
        events = [e.type for e in (queue.get_nowait() for _ in range(queue.qsize())) if e.type.startswith("contract_")]
    finally:
        await bus.unsubscribe(f"project:{project.id}", queue)
    assert events == ["contract_check_started", "contract_check_progress", "contract_check_progress",
                      "contract_check_progress", "contract_check_finished"]

    # only root-project models are checked; head adds parents and children, base parents
    assert faked["compile"] == [(None, "1+dim_customers+1"), ("HEAD", "1+dim_customers")]
    check = faked["check"][0]
    assert check["uids"] == [DIM] and check["types"] is None and check["base"] is not None

    latest = (await client.get(f"/api/projects/{project.id}/impact/contracts?scope=working")).json()
    assert latest["status"] == "done" and latest["base_sha"] == "aaaaaaa" and latest["target"] == "dev"
    assert latest["results"][0]["severity"] == "error" and latest["results"][0]["dbt_state_contract"] is None
    assert "packages differ" in latest["notes"] and any("column lineage" in n for n in latest["notes"])
    assert not latest["lineage_used"]
    assert (await client.get(f"/api/projects/{project.id}/impact/contracts?scope=branch")).json() is None


async def test_branch_check_uses_the_merge_base_types_and_lineage(client, project, faked, db_session) -> None:
    db_session.add(ColumnLineageSnapshot(project_id=project.id, status="done", lineage_version=4,
                                         results_json=json.dumps({"m": {"c": []}}), row_dependencies_json="{}"))
    await db_session.commit()
    resp = await client.post(f"/api/projects/{project.id}/impact/contracts",
                             json={"scope": "branch", "base": "main", "types": True})
    assert resp.status_code == 202
    await _wait(project.id)
    assert faked["compile"][1] == ("f" * 40, "1+dim_customers")
    assert faked["types"] == [[f"base:{DIM}", f"head:{DIM}"]]
    check = faked["check"][0]
    assert check["types"] == {"head": {DIM: {"id": "integer"}}, "base": {DIM: {"id": "integer"}}}
    assert check["lineage"] == {"m": {"c": []}}
    latest = (await client.get(f"/api/projects/{project.id}/impact/contracts?scope=branch")).json()
    assert latest["lineage_used"] and latest["base"] == "main" and latest["types"]


async def test_a_base_that_does_not_compile_leaves_the_self_check(client, project, faked, monkeypatch) -> None:
    real = api.compiled_manifest

    async def flaky(project, *, ref, select, target=None):
        if ref is not None:
            raise RevisionError("compile_failed", "Database Error\n  could not connect to server")
        return await real(project, ref=ref, select=select, target=target)

    monkeypatch.setattr(api, "compiled_manifest", flaky)
    await client.post(f"/api/projects/{project.id}/impact/contracts", json={"scope": "working"})
    await _wait(project.id)
    assert faked["check"][0]["base"] is None
    latest = (await client.get(f"/api/projects/{project.id}/impact/contracts")).json()
    assert latest["status"] == "done"
    assert any("Couldn't compile HEAD" in n and "could not connect" in n for n in latest["notes"])


async def test_a_head_compile_failure_is_an_error(client, project, faked, monkeypatch) -> None:
    async def failing(project, *, ref, select, target=None):
        raise RevisionError("compile_failed", "Compilation Error in model dim_customers")

    monkeypatch.setattr(api, "compiled_manifest", failing)
    await client.post(f"/api/projects/{project.id}/impact/contracts", json={"scope": "working"})
    await _wait(project.id)
    latest = (await client.get(f"/api/projects/{project.id}/impact/contracts")).json()
    assert latest["status"] == "error" and "Compilation Error" in latest["error_message"]


async def test_running_check_conflicts(client, project, faked) -> None:
    gate = asyncio.Event()
    api._running[project.id] = asyncio.create_task(gate.wait())
    try:
        resp = await client.post(f"/api/projects/{project.id}/impact/contracts", json={"scope": "working"})
        assert resp.status_code == 409
    finally:
        gate.set()
        await api._running.pop(project.id)


async def test_no_changed_models_skips_compiling(client, project, faked, monkeypatch) -> None:
    async def nothing(project, scope, base):
        return ChangeSet("main", None, None, ChangeMapping(nodes={SEED: ()}, unmapped=(), project_wide=(),
                                                                relevant_files=1), True)

    monkeypatch.setattr(api, "load_change_set", nothing)
    await client.post(f"/api/projects/{project.id}/impact/contracts", json={"scope": "working"})
    await _wait(project.id)
    assert faked["compile"] == [] and faked["check"] == []
    assert (await client.get(f"/api/projects/{project.id}/impact/contracts")).json()["results"] == []


def test_selections() -> None:
    assert api.head_selection(["b", "a", "a"]) == "1+a+1 1+b+1"
    assert api.base_selection(["b", "a"]) == "1+a 1+b"


async def test_semantic_consumers_collects_dashboards_and_monitors(tmp_path: Path, db_session, project) -> None:
    folder = Path(project.path) / "wickd" / "dashboards"
    folder.mkdir(parents=True)
    (folder / "growth.yml").write_text(
        "version: 1\ntitle: Growth\nwidgets:\n  - id: a\n    metrics: [revenue, orders]\n  - id: b\n    metrics: [revenue]\n")
    (folder / "broken.yml").write_text("title: [")
    assert dashboards_by_metric(Path(project.path), None) == {
        "revenue": [{"slug": "growth", "title": "Growth"}], "orders": [{"slug": "growth", "title": "Growth"}]}
    db_session.add(MetricMonitor(project_id=project.id, metric="revenue", grain="day", lookback=30))
    await db_session.commit()
    found = await semantic_consumers(db_session, project.id, Path(project.path))
    assert found["revenue"]["monitors"][0]["metric"] == "revenue"
    assert found["orders"]["monitors"] == []


def test_types_sql_escapes_jinja_and_output_parses() -> None:
    sql = contract_types.build_types_sql({"head:m": "select '{{ x }}' as a -- %}"})
    first_line = sql.splitlines()[0]
    assert "{{ x }}" not in first_line and "\\u007b" in first_line
    assert "get_column_schema_from_query" in sql
    out = f'noise\n{contract_types.TYPES_MARKER}{{"head:m": [["a", "text"], ["b", null]]}}\n'
    assert contract_types.parse_types_output(out) == {"head:m": {"a": "text", "b": ""}}
    assert contract_types.parse_types_output("nothing") is None
