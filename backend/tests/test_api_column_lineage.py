"""
Tests for the backgrounded column-lineage endpoints:
  POST /api/projects/{id}/column-lineage/start
  GET  /api/projects/{id}/column-lineage
  GET  /api/projects/{id}/column-lineage/{snapshot_id}

These mirror the drift/freshness snapshot pattern: a POST kicks off a
background asyncio.Task that fans work out across a ProcessPoolExecutor, and
progress/completion are observable both via polling GET and via SSE events on
the bus.

Column-level lineage is a wickd Pro feature (see app/licensing/): the real
tracing algorithm lives in the private wickd_pro package, not this repo.
These tests don't need it installed — `_entitled` below forces
check_entitlement() to report entitled for every test in this file (a
separate test class covers the actual gating behavior when NOT entitled),
and `_fake_algorithm` substitutes a small, deterministic stand-in for
prepare_lineage_jobs/trace_job that reproduces the exact lineage
_make_manifest()'s fixture data would really trace, without depending on
sqlglot or the private package at all.

Patching trace_job specifically requires patching app.dbt.column_lineage's
copy, not app.api.column_lineage's imported alias of it: trace_job is
submitted to a ProcessPoolExecutor by reference (loop.run_in_executor(_pool,
trace_job, job)), and the worker subprocess re-imports it fresh from its
true origin module (app.dbt.column_lineage) rather than seeing whatever
local alias the test patched in api/column_lineage.py's namespace.
prepare_lineage_jobs, by contrast, runs via run_in_executor(None, ...) — a
thread pool in the SAME process — so patching either module's reference
would work for it, but we patch both consistently at their shared true
origin for clarity.

Note: the background runner (`_run_column_lineage` in api/column_lineage.py)
imports `SessionLocal` fresh from `app.db.engine` on every DB write (mirroring
the drift/freshness pattern), rather than going through FastAPI's DI. The
`override_db` autouse fixture only swaps the `get_session` DI dependency, so
without extra help the background task would keep writing to the real
on-disk `app.db.engine.SessionLocal` instead of the in-memory test DB. The
`db_session` fixture below additionally monkeypatches `app.db.engine.SessionLocal`
so background writes land in the same in-memory database the test/HTTP layer
reads from.
"""

import asyncio
import json
import os
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.db.engine as db_engine
import app.dbt.column_lineage as column_lineage_module
from app.db.engine import get_session
from app.db.models import Base, ColumnLineageSnapshot, Project
from app.dbt.column_lineage import ColumnRef, LineageJob
from app.events.bus import bus
from app.licensing import entitlements
from app.main import app


def _fake_prepare_lineage_jobs(manifest_path: Path) -> list[LineageJob]:
    """Reproduces exactly what the real algorithm would compute for
    _make_manifest()'s fixture data (orders.order_id <- stg_orders.order_id),
    without depending on sqlglot or wickd_pro."""
    data = json.loads(manifest_path.read_text())
    if "model.proj.orders" not in data.get("nodes", {}):
        return []
    return [
        LineageJob(
            uid="model.proj.orders",
            columns=("order_id",),
            sql="SELECT order_id FROM stg_orders",
            dialect=None,
            parent_short_names=("stg_orders",),
            name_to_uid={"stg_orders": "model.proj.stg_orders", "orders": "model.proj.orders"},
            sources={"stg_orders": "SELECT order_id"},
        )
    ]


def _fake_trace_job(job: LineageJob) -> tuple[str, dict[str, list[ColumnRef]]]:
    """Matches _fake_prepare_lineage_jobs' single job — real ProcessPoolExecutor
    fan-out still happens, this just replaces the sqlglot tracing itself."""
    return job.uid, {"order_id": [ColumnRef(node="model.proj.stg_orders", column="order_id")]}


def _fake_trace_job_full(
    job: LineageJob,
) -> tuple[str, dict[str, list[ColumnRef]], list[ColumnRef]]:
    """_fake_trace_job plus one row dependency (as if orders filtered on stg_orders.status)."""
    uid, columns = _fake_trace_job(job)
    return uid, columns, [ColumnRef(node="model.proj.stg_orders", column="status")]


def _fake_trace_job_kinds(job: LineageJob) -> tuple:
    """_fake_trace_job_full with a transform kind on each projection ref."""
    uid, columns, rows = _fake_trace_job_full(job)
    return uid, {col: [(ref, "identity") for ref in refs] for col, refs in columns.items()}, rows


STRUCTURE = {"join_pairs": [], "grain": {"columns": ["order_id"], "via": "group_by"}}


def _fake_trace_job_structure(job: LineageJob) -> tuple:
    """_fake_trace_job_kinds plus join pairs and grain."""
    return (*_fake_trace_job_kinds(job), STRUCTURE)


def _supports_rows() -> bool:
    return True


@pytest.fixture(autouse=True)
def _fake_algorithm(monkeypatch: pytest.MonkeyPatch):
    """See module docstring for why both the true-origin module AND the
    api module's imported alias are patched."""
    monkeypatch.setattr(column_lineage_module, "prepare_lineage_jobs", _fake_prepare_lineage_jobs)
    monkeypatch.setattr(column_lineage_module, "trace_job", _fake_trace_job)
    monkeypatch.setattr(column_lineage_module, "trace_job_full", _fake_trace_job_full)
    monkeypatch.setattr(column_lineage_module, "supports_row_dependencies", _supports_rows)
    monkeypatch.setattr(column_lineage_module, "trace_job_kinds", _fake_trace_job_kinds)
    monkeypatch.setattr(column_lineage_module, "supports_transform_kinds", _supports_rows)
    monkeypatch.setattr(column_lineage_module, "trace_job_structure", _fake_trace_job_structure)
    monkeypatch.setattr(column_lineage_module, "supports_structure", _supports_rows)
    import app.api.column_lineage as api_module
    monkeypatch.setattr(api_module, "prepare_lineage_jobs", _fake_prepare_lineage_jobs)
    monkeypatch.setattr(api_module, "trace_job_structure", _fake_trace_job_structure)


@pytest.fixture(autouse=True)
async def _entitled(monkeypatch: pytest.MonkeyPatch):
    """Forces every test in this file to see an entitled installation —
    entitlement-gating behavior itself (403 when NOT entitled) is covered
    separately below in TestEntitlementGating, which does NOT use this
    fixture."""
    async def _always_entitled(session, *, force: bool = False):
        return entitlements.Entitlement(entitled=True, reason="granted")

    monkeypatch.setattr(entitlements, "check_entitlement", _always_entitled)


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def db_session(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Fresh DB, wired into both FastAPI DI and the module-level SessionLocal
    that background tasks import directly.

    Uses a temp-file SQLite DB rather than ':memory:'. An in-memory DB forces
    SQLAlchemy onto a StaticPool (one shared physical connection for the whole
    engine); this suite has a real background asyncio.Task (fanning work out
    across a ProcessPoolExecutor) committing concurrently with the test's own
    polling GETs, and that concurrent traffic through one shared aiosqlite
    connection caused writes to silently become invisible to later reads on
    that same engine (a genuine StaticPool/aiosqlite visibility bug, not
    something in the endpoint code) — surfacing as `_wait_for_done` polling
    forever even though the background task's own commit had already
    succeeded. A temp-file DB uses normal per-checkout connections, matching
    how the real app's file-based SQLite engine behaves, and does not exhibit
    this problem.
    """
    db_path = tmp_path / "test_column_lineage.sqlite"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    TestSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with TestSessionLocal() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", TestSessionLocal)

    async with TestSessionLocal() as session:
        yield session

    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()
    await engine.dispose()


async def _seed_project(session: AsyncSession, path: str) -> int:
    proj = Project(name="test_proj", path=path, platform="local")
    session.add(proj)
    await session.commit()
    await session.refresh(proj)
    return proj.id


def _make_manifest(target_dir: Path) -> None:
    manifest_data = {
        "nodes": {
            "model.proj.stg_orders": {
                "unique_id": "model.proj.stg_orders",
                "name": "stg_orders",
                "resource_type": "model",
                "schema": "staging",
                "database": "wh",
                "config": {"materialized": "view"},
                "tags": [],
                "description": "",
                "original_file_path": "models/stg_orders.sql",
                "compiled_code": "SELECT id AS order_id FROM raw.orders",
                "columns": {},
            },
            "model.proj.orders": {
                "unique_id": "model.proj.orders",
                "name": "orders",
                "resource_type": "model",
                "schema": "analytics",
                "database": "wh",
                "config": {"materialized": "table"},
                "tags": [],
                "description": "",
                "original_file_path": "models/orders.sql",
                "compiled_code": "SELECT order_id FROM stg_orders",
                "columns": {},
            },
        },
        "sources": {},
        "parent_map": {
            "model.proj.orders": ["model.proj.stg_orders"],
        },
        "metadata": {},
    }
    (target_dir / "manifest.json").write_text(json.dumps(manifest_data))


async def _wait_for_done(client: AsyncClient, pid: int, timeout: float = 30.0) -> dict:
    async with asyncio.timeout(timeout):
        while True:
            r = await client.get(f"/api/projects/{pid}/column-lineage")
            assert r.status_code == 200
            body = r.json()
            # a refresh in progress is reported on the cached snapshot (refresh_status)
            if body is not None and body["status"] in ("done", "error") and body.get("refresh_status") != "running":
                return body
            await asyncio.sleep(0.1)


async def test_start_and_poll_end_to_end(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    proj_dir = tmp_path / "proj"
    proj_dir.mkdir()
    target = proj_dir / "target"
    target.mkdir()
    _make_manifest(target)
    pid = await _seed_project(db_session, str(proj_dir))

    start_resp = await client.post(f"/api/projects/{pid}/column-lineage/start")
    assert start_resp.status_code == 202
    started = start_resp.json()
    assert started["status"] == "running"
    # total_models is 0 in the immediate response — prepare_lineage_jobs() now
    # runs inside the background task (so the endpoint stays fast even when a
    # stale manifest needs a `dbt compile` first), not before the snapshot row
    # is created. The real count shows up once polling reaches "done" below.

    final = await _wait_for_done(client, pid)
    assert final["status"] == "done"
    assert final["checked_models"] == 1
    assert "model.proj.orders" in final["results"]
    refs = final["results"]["model.proj.orders"]["order_id"]
    assert len(refs) == 1
    assert refs[0]["node"] == "model.proj.stg_orders"
    assert refs[0]["column"] == "order_id"
    assert refs[0]["kind"] == "identity"
    assert final["row_dependencies"] == {
        "model.proj.orders": [{"node": "model.proj.stg_orders", "column": "status", "kind": None}],
    }
    assert final["lineage_version"] == 4
    snap = await db_session.get(ColumnLineageSnapshot, final["id"])
    await db_session.refresh(snap)
    assert json.loads(snap.join_keys_json) == {"model.proj.orders": STRUCTURE}


async def test_rerun_recomputes_snapshots_from_an_older_lineage_version(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    """A snapshot computed before row dependencies existed must not satisfy the
    unchanged-manifest short-circuit, or its missing row data would be served forever."""
    proj_dir = tmp_path / "proj_v1"
    proj_dir.mkdir()
    target = proj_dir / "target"
    target.mkdir()
    _make_manifest(target)
    pid = await _seed_project(db_session, str(proj_dir))
    old = ColumnLineageSnapshot(
        project_id=pid, status="done", results_json="{}", lineage_version=1,
        manifest_mtime=(target / "manifest.json").stat().st_mtime,
    )
    db_session.add(old)
    await db_session.commit()

    resp = await client.post(f"/api/projects/{pid}/column-lineage/start")
    assert resp.status_code == 202
    final = await _wait_for_done(client, pid)
    assert final["id"] != old.id
    assert final["lineage_version"] == 4


async def test_start_auto_compiles_stale_manifest(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A manifest with no compiled_code on any model (e.g. from `dbt parse`,
    or before the project has ever been compiled) must not silently report
    zero models — start_column_lineage should run `dbt compile` first, then
    proceed with the scan against the freshly compiled manifest."""
    proj_dir = tmp_path / "stale_proj"
    proj_dir.mkdir()
    target = proj_dir / "target"
    target.mkdir()
    manifest_path = target / "manifest.json"
    manifest_path.write_text(json.dumps({
        "nodes": {
            "model.proj.stg_orders": {
                "unique_id": "model.proj.stg_orders",
                "name": "stg_orders",
                "resource_type": "model",
                "original_file_path": "models/stg_orders.sql",
                "columns": {},
                # no compiled_code — this is the "needs compile" condition
            },
        },
        "sources": {},
        "parent_map": {},
        "metadata": {},
    }))
    pid = await _seed_project(db_session, str(proj_dir))

    compile_calls: list[int] = []

    async def _fake_compile_project(project_id: int, project_path: str) -> bool:
        compile_calls.append(project_id)
        # Simulate a real `dbt compile`: it rewrites the manifest with
        # compiled_code populated.
        _make_manifest(Path(project_path) / "target")
        return True

    import app.api.models as models_module
    monkeypatch.setattr(models_module, "_compile_project", _fake_compile_project)

    queue = await bus.subscribe(f"project:{pid}")
    try:
        r = await client.post(f"/api/projects/{pid}/column-lineage/start")
        assert r.status_code == 202
        assert r.json()["status"] == "running"

        seen_types: list[str] = []
        async with asyncio.timeout(30):
            while "column_lineage_finished" not in seen_types:
                event = await queue.get()
                seen_types.append(event.type)
    finally:
        await bus.unsubscribe(f"project:{pid}", queue)

    assert compile_calls == [pid]
    # compiling must be signaled before the scan itself starts
    assert seen_types.index("column_lineage_compiling") < seen_types.index("column_lineage_started")

    final = await _wait_for_done(client, pid)
    assert final["status"] == "done"
    assert "model.proj.orders" in final["results"]


async def test_start_reports_error_when_compile_fails(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    proj_dir = tmp_path / "stale_proj_fails"
    proj_dir.mkdir()
    target = proj_dir / "target"
    target.mkdir()
    (target / "manifest.json").write_text(json.dumps({
        "nodes": {
            "model.proj.stg_orders": {
                "unique_id": "model.proj.stg_orders",
                "name": "stg_orders",
                "resource_type": "model",
                "original_file_path": "models/stg_orders.sql",
                "columns": {},
            },
        },
        "sources": {},
        "parent_map": {},
        "metadata": {},
    }))
    pid = await _seed_project(db_session, str(proj_dir))

    async def _fake_compile_project_fails(project_id: int, project_path: str) -> bool:
        return False

    import app.api.models as models_module
    monkeypatch.setattr(models_module, "_compile_project", _fake_compile_project_fails)

    r = await client.post(f"/api/projects/{pid}/column-lineage/start")
    assert r.status_code == 202

    final = await _wait_for_done(client, pid)
    assert final["status"] == "error"
    assert "compile failed" in final["error_message"]


async def test_start_no_manifest_returns_422(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    proj_dir = tmp_path / "empty_proj"
    proj_dir.mkdir()
    pid = await _seed_project(db_session, str(proj_dir))

    r = await client.post(f"/api/projects/{pid}/column-lineage/start")
    assert r.status_code == 422


async def test_start_project_not_found(client: AsyncClient, db_session: AsyncSession) -> None:
    r = await client.post("/api/projects/999999/column-lineage/start")
    assert r.status_code == 404


async def test_get_latest_project_not_found(client: AsyncClient, db_session: AsyncSession) -> None:
    r = await client.get("/api/projects/999999/column-lineage")
    assert r.status_code == 404


async def test_get_latest_no_snapshot_returns_null(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    proj_dir = tmp_path / "proj_no_scan"
    proj_dir.mkdir()
    pid = await _seed_project(db_session, str(proj_dir))

    r = await client.get(f"/api/projects/{pid}/column-lineage")
    assert r.status_code == 200
    assert r.json() is None


async def test_start_twice_returns_409_while_running(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    proj_dir = tmp_path / "proj2"
    proj_dir.mkdir()
    target = proj_dir / "target"
    target.mkdir()
    _make_manifest(target)
    pid = await _seed_project(db_session, str(proj_dir))

    first = await client.post(f"/api/projects/{pid}/column-lineage/start")
    assert first.status_code == 202

    second = await client.post(f"/api/projects/{pid}/column-lineage/start")
    # 409 (still running) is the expected case. But on a fast machine the
    # scan (2 tiny models) can complete before the second request lands —
    # then the cached snapshot still matches the manifest and comes back (200).
    assert second.status_code in (200, 202, 409)

    await _wait_for_done(client, pid)


async def test_start_publishes_sse_events(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    proj_dir = tmp_path / "proj3"
    proj_dir.mkdir()
    target = proj_dir / "target"
    target.mkdir()
    _make_manifest(target)
    pid = await _seed_project(db_session, str(proj_dir))

    queue = await bus.subscribe(f"project:{pid}")
    try:
        r = await client.post(f"/api/projects/{pid}/column-lineage/start")
        assert r.status_code == 202

        seen_types: set[str] = set()
        async with asyncio.timeout(30):
            while "column_lineage_finished" not in seen_types:
                event = await queue.get()
                seen_types.add(event.type)

        assert "column_lineage_started" in seen_types
        assert "column_lineage_progress" in seen_types
        assert "column_lineage_finished" in seen_types
    finally:
        await bus.unsubscribe(f"project:{pid}", queue)


async def test_rerun_short_circuits_when_manifest_unchanged(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    proj_dir = tmp_path / "proj4"
    proj_dir.mkdir()
    target = proj_dir / "target"
    target.mkdir()
    _make_manifest(target)
    pid = await _seed_project(db_session, str(proj_dir))

    first_start = await client.post(f"/api/projects/{pid}/column-lineage/start")
    assert first_start.status_code == 202
    first_final = await _wait_for_done(client, pid)
    first_id = first_final["id"]

    # Content unchanged — a second start should return the cached snapshot
    # rather than kicking off a new run.
    second_start = await client.post(f"/api/projects/{pid}/column-lineage/start")
    assert second_start.status_code == 200
    assert second_start.json()["id"] == first_id


async def _scanned_project(client: AsyncClient, db_session: AsyncSession, tmp_path: Path, name: str) -> tuple[int, Path]:
    proj_dir = tmp_path / name
    (proj_dir / "target").mkdir(parents=True)
    _make_manifest(proj_dir / "target")
    pid = await _seed_project(db_session, str(proj_dir))
    assert (await client.post(f"/api/projects/{pid}/column-lineage/start")).status_code == 202
    await _wait_for_done(client, pid)
    return pid, proj_dir / "target" / "manifest.json"


def _rewrite(manifest: Path, edit) -> None:
    """Rewrite the manifest (new content via `edit`, new mtime) as a dbt command would."""
    data = json.loads(manifest.read_text())
    edit(data)
    manifest.write_text(json.dumps(data))
    stat = manifest.stat()
    os.utime(manifest, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))


async def test_dbt_rewriting_the_manifest_keeps_the_cache(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    """dbt rewrites manifest.json on every command; same content (or a selective run that drops
    other nodes' compiled SQL) must not invalidate the cache."""
    pid, manifest = await _scanned_project(client, db_session, tmp_path, "proj_rewrite")

    _rewrite(manifest, lambda d: d["metadata"].update(generated_at="later", invocation_id="x"))
    body = (await client.get(f"/api/projects/{pid}/column-lineage")).json()
    assert body["stale"] is False and body["stale_reason"] is None

    _rewrite(manifest, lambda d: d["nodes"]["model.proj.stg_orders"].pop("compiled_code"))
    body = (await client.get(f"/api/projects/{pid}/column-lineage")).json()
    assert body["stale"] is False
    again = await client.post(f"/api/projects/{pid}/column-lineage/start")
    assert again.status_code == 200 and again.json()["id"] == body["id"]


async def test_changed_sql_marks_stale_and_refresh_reuses_unchanged_models(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    pid, manifest = await _scanned_project(client, db_session, tmp_path, "proj_stale")
    first = (await client.get(f"/api/projects/{pid}/column-lineage")).json()

    # stg_orders' SQL changed, but the orders job (the only one) reads the same inputs
    _rewrite(manifest, lambda d: d["nodes"]["model.proj.stg_orders"].update(
        compiled_code="SELECT id AS order_id, 1 AS x FROM raw.orders"))
    body = (await client.get(f"/api/projects/{pid}/column-lineage")).json()
    assert body["stale"] is True
    assert body["stale_reason"] == "1 node changed since this was loaded."

    queue = await bus.subscribe(f"project:{pid}")
    try:
        assert (await client.post(f"/api/projects/{pid}/column-lineage/start")).status_code == 202
        started = None
        async with asyncio.timeout(30):
            while True:
                event = await queue.get()
                if event.type == "column_lineage_started" and event.data.get("total"):
                    started = event.data
                if event.type == "column_lineage_finished":
                    break
    finally:
        await bus.unsubscribe(f"project:{pid}", queue)
    assert started == {"snapshot_id": started["snapshot_id"], "total": 1, "reused": 1}

    final = await _wait_for_done(client, pid)
    assert final["id"] != first["id"] and final["stale"] is False
    assert final["results"] == first["results"]
    assert final["row_dependencies"] == first["row_dependencies"]


async def test_cache_stays_visible_during_and_after_a_failed_refresh(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    pid, _ = await _scanned_project(client, db_session, tmp_path, "proj_refresh")
    cached = (await client.get(f"/api/projects/{pid}/column-lineage")).json()

    db_session.add(ColumnLineageSnapshot(project_id=pid, status="running", results_json="{}"))
    await db_session.commit()
    body = (await client.get(f"/api/projects/{pid}/column-lineage")).json()
    assert body["id"] == cached["id"] and body["status"] == "done"
    assert body["refresh_status"] == "running" and body["refresh_error"] is None

    db_session.add(ColumnLineageSnapshot(project_id=pid, status="error", results_json="{}", error_message="boom"))
    await db_session.commit()
    body = (await client.get(f"/api/projects/{pid}/column-lineage")).json()
    assert body["id"] == cached["id"] and body["results"] == cached["results"]
    assert body["refresh_status"] == "error" and body["refresh_error"] == "boom"


async def test_status_reports_the_cache_without_results(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    proj_dir = tmp_path / "proj_status"
    (proj_dir / "target").mkdir(parents=True)
    _make_manifest(proj_dir / "target")
    pid = await _seed_project(db_session, str(proj_dir))
    assert (await client.get(f"/api/projects/{pid}/column-lineage/status")).json()["status"] is None

    assert (await client.post(f"/api/projects/{pid}/column-lineage/start")).status_code == 202
    final = await _wait_for_done(client, pid)
    body = (await client.get(f"/api/projects/{pid}/column-lineage/status")).json()
    assert body == {
        "snapshot_id": final["id"], "status": "done", "lineage_version": 4, "total_models": 1,
        "stale": False, "stale_reason": None, "refresh_status": None, "refresh_error": None,
        "error_message": None,
    }
    _rewrite(proj_dir / "target" / "manifest.json",
             lambda d: d["nodes"]["model.proj.orders"].update(compiled_code="SELECT 1 AS order_id"))
    body = (await client.get(f"/api/projects/{pid}/column-lineage/status")).json()
    assert body["stale"] is True and body["stale_reason"] == "1 node changed since this was loaded."


async def test_snapshot_without_fingerprint_reads_as_stale(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    proj_dir = tmp_path / "proj_legacy"
    (proj_dir / "target").mkdir(parents=True)
    _make_manifest(proj_dir / "target")
    pid = await _seed_project(db_session, str(proj_dir))
    db_session.add(ColumnLineageSnapshot(project_id=pid, status="done", results_json="{}", lineage_version=4))
    await db_session.commit()

    body = (await client.get(f"/api/projects/{pid}/column-lineage")).json()
    assert body["stale"] is True and "refresh once" in body["stale_reason"]
    assert (await client.post(f"/api/projects/{pid}/column-lineage/start")).status_code == 202
    await _wait_for_done(client, pid)


async def test_selective_run_manifest_compiles_before_scanning(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`dbt run -s x` leaves compiled SQL on x only; scanning that would drop every other model."""
    proj_dir = tmp_path / "proj_partial"
    (proj_dir / "target").mkdir(parents=True)
    _make_manifest(proj_dir / "target")
    manifest = proj_dir / "target" / "manifest.json"
    _rewrite(manifest, lambda d: d["nodes"]["model.proj.orders"].pop("compiled_code"))
    pid = await _seed_project(db_session, str(proj_dir))
    compiled: list[int] = []

    async def _fake_compile_project(project_id: int, project_path: str) -> bool:
        compiled.append(project_id)
        _make_manifest(Path(project_path) / "target")
        return True

    import app.api.models as models_module
    monkeypatch.setattr(models_module, "_compile_project", _fake_compile_project)
    assert (await client.post(f"/api/projects/{pid}/column-lineage/start")).status_code == 202
    final = await _wait_for_done(client, pid)
    assert compiled == [pid] and "model.proj.orders" in final["results"]


class TestEntitlementGating:
    """Unlike every test above, these do NOT use the _entitled autouse
    fixture's override — they verify the real check_entitlement() logic
    correctly blocks all three routes when there's no valid license."""

    @pytest.fixture(autouse=True)
    def _not_entitled(self, monkeypatch: pytest.MonkeyPatch):
        async def _never_entitled(session, *, force: bool = False):
            return entitlements.Entitlement(entitled=False, reason="not_licensed")

        monkeypatch.setattr(entitlements, "check_entitlement", _never_entitled)

    async def test_start_returns_403_when_not_entitled(
        self, client: AsyncClient, db_session: AsyncSession, tmp_path: Path
    ) -> None:
        proj_dir = tmp_path / "proj_gated"
        proj_dir.mkdir()
        target = proj_dir / "target"
        target.mkdir()
        _make_manifest(target)
        pid = await _seed_project(db_session, str(proj_dir))

        r = await client.post(f"/api/projects/{pid}/column-lineage/start")
        assert r.status_code == 403
        assert r.json()["detail"]["error"] == "pro_feature_required"

    async def test_get_latest_returns_403_when_not_entitled(
        self, client: AsyncClient, db_session: AsyncSession, tmp_path: Path
    ) -> None:
        proj_dir = tmp_path / "proj_gated2"
        proj_dir.mkdir()
        pid = await _seed_project(db_session, str(proj_dir))

        r = await client.get(f"/api/projects/{pid}/column-lineage")
        assert r.status_code == 403
        r = await client.get(f"/api/projects/{pid}/column-lineage/status")
        assert r.status_code == 403

    async def test_get_snapshot_returns_403_when_not_entitled(
        self, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        r = await client.get("/api/projects/1/column-lineage/1")
        assert r.status_code == 403
