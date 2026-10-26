"""Run timing capture: run_results.json timing → invocation_model_results → the
run detail endpoint, plus the startup migration that adds the columns.

_persist_results_after_run opens sessions via SessionLocal, so the `db`
fixture points DI and the module-level SessionLocal at one temp-file DB (same
setup as test_api_custom_command.py).
"""
import json
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.api.runs as runs_module
import app.db.engine as db_engine
from app.db import migrations
from app.db.engine import get_session
from app.db.models import Base, InvocationModelResult, Project, RunInvocation
from app.main import app


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", factory)
    monkeypatch.setattr(runs_module, "SessionLocal", factory)
    monkeypatch.setattr(migrations, "SessionLocal", factory)
    yield factory
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _project_with_invocation(db, tmp_path: Path) -> tuple[Project, int]:
    project_dir = tmp_path / "proj"
    (project_dir / "target").mkdir(parents=True)
    async with db() as session:
        proj = Project(name="proj", path=str(project_dir), platform="duckdb")
        session.add(proj)
        await session.commit()
        inv = RunInvocation(project_id=proj.id, command="build", status="running")
        session.add(inv)
        await session.commit()
        return proj, inv.id


def _write_results(project: Project, results: list[dict], **top) -> None:
    path = Path(project.path) / "target" / "run_results.json"
    path.write_text(json.dumps({"results": results, **top}))


def _result(uid: str, start: str, end: str, **extra) -> dict:
    return {
        "unique_id": uid,
        "status": "success",
        "execution_time": 1.0,
        "thread_id": "Thread-1 (worker)",
        "timing": [{"name": "execute", "started_at": start, "completed_at": end}],
        "adapter_response": {"rows_affected": 5},
        **extra,
    }


async def test_persist_records_timing_and_run_threads(db, tmp_path: Path) -> None:
    project, inv_id = await _project_with_invocation(db, tmp_path)
    _write_results(
        project,
        [_result("model.proj.orders", "2026-10-22T10:00:00Z", "2026-10-22T10:00:03Z")],
        elapsed_time=3.4,
        args={"threads": 4},
    )

    await runs_module._persist_results_after_run(project, inv_id)

    async with db() as session:
        [row] = (await session.execute(select(InvocationModelResult))).scalars().all()
        inv = await session.get(RunInvocation, inv_id)
    assert row.thread_id == "Thread-1 (worker)"
    assert row.rows_affected == 5
    assert json.loads(row.adapter_response_json) == {"rows_affected": 5}
    assert row.started_at is not None and row.completed_at is not None
    assert (row.completed_at - row.started_at).total_seconds() == 3
    assert (inv.threads, inv.elapsed_time) == (4, 3.4)


async def test_detail_returns_timing(db, client: AsyncClient, tmp_path: Path) -> None:
    project, inv_id = await _project_with_invocation(db, tmp_path)
    _write_results(project, [_result("model.proj.orders", "2026-10-22T10:00:00Z", "2026-10-22T10:00:03Z")])
    await runs_module._persist_results_after_run(project, inv_id)

    body = (await client.get(f"/api/projects/{project.id}/run-history/{inv_id}")).json()

    assert body["has_timing"] is True
    assert body["threads"] == 1  # args missing → distinct thread ids
    [node] = body["nodes"]
    assert node["started_at"].startswith("2026-10-22T10:00:00")
    assert node["started_at"].endswith(("Z", "+00:00"))
    assert node["thread_id"] == "Thread-1 (worker)"


async def test_detail_without_timing_reports_has_timing_false(db, client: AsyncClient, tmp_path: Path) -> None:
    project, inv_id = await _project_with_invocation(db, tmp_path)
    _write_results(project, [{"unique_id": "model.proj.orders", "status": "success", "execution_time": 1.0}])
    await runs_module._persist_results_after_run(project, inv_id)

    body = (await client.get(f"/api/projects/{project.id}/run-history/{inv_id}")).json()

    assert body["has_timing"] is False
    assert body["nodes"][0]["started_at"] is None


async def test_migration_adds_timing_columns_and_keeps_existing_rows(
    db, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _noop() -> None:
        return None

    monkeypatch.setattr(migrations, "ensure_db_initialized", _noop)
    async with db() as session:
        # Recreate both tables in their pre-timing shape, with a row each
        await session.execute(text("DROP TABLE invocation_model_results"))
        await session.execute(text("DROP TABLE run_invocations"))
        await session.execute(text(
            "CREATE TABLE run_invocations (id INTEGER PRIMARY KEY, project_id INTEGER, command TEXT,"
            " selector TEXT, cli_command TEXT, profile TEXT, target TEXT, status TEXT, log_path TEXT,"
            " started_at DATETIME, finished_at DATETIME, custom_args TEXT)"
        ))
        await session.execute(text(
            "CREATE TABLE invocation_model_results (id INTEGER PRIMARY KEY, invocation_id INTEGER,"
            " project_id INTEGER, unique_id TEXT, name TEXT, kind TEXT, status TEXT,"
            " execution_time REAL, message TEXT)"
        ))
        await session.execute(text("INSERT INTO run_invocations (id, command, status) VALUES (1, 'run', 'success')"))
        await session.execute(text(
            "INSERT INTO invocation_model_results (id, invocation_id, unique_id, name, kind, status, execution_time)"
            " VALUES (1, 1, 'model.p.a', 'a', 'model', 'success', 2.5)"
        ))
        await session.commit()

    await migrations.run_migrations()
    await migrations.run_migrations()  # idempotent

    async with db() as session:
        row = (await session.execute(text(
            "SELECT execution_time, started_at, thread_id, adapter_response_json FROM invocation_model_results"
        ))).one()
        inv = (await session.execute(text("SELECT threads, elapsed_time FROM run_invocations"))).one()
    assert tuple(row) == (2.5, None, None, None)
    assert tuple(inv) == (None, None)
