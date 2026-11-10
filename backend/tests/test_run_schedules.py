"""Scheduled runs (plan 27): routes (api/run_schedules.py), the scheduler
(app/runs/scheduler.py) and the run-history trigger fields.

The scheduler and the background invocation open sessions through `SessionLocal`
directly, so (as in test_api_custom_command.py) the `db` fixture points DI and the
module-level references at one temp-file SQLite DB.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.api.runs as runs_module
import app.db.engine as db_engine
from app.db.engine import get_session
from app.db.models import Base, Project, RunInvocation, RunSchedule, RunScheduleEvent
from app.dbt.runner import RunRequest, runner
from app.events.bus import bus
from app.main import app
from app.runs import scheduler
from app.scheduling import loop as scheduler_loop


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'test.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async def _get_session():
        async with session_factory() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    monkeypatch.setattr(db_engine, "SessionLocal", session_factory)
    monkeypatch.setattr(runs_module, "SessionLocal", session_factory)
    scheduler._pending.clear()
    yield session_factory
    for task in list(scheduler._tasks):
        task.cancel()
    scheduler._pending.clear()
    app.dependency_overrides.pop(get_session, None)
    await engine.dispose()


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture
async def project(db, tmp_path: Path) -> Project:
    project_dir = tmp_path / "proj"
    (project_dir / "target").mkdir(parents=True)
    (project_dir / "profiles.yml").write_text(
        "proj:\n  target: dev\n  outputs:\n    dev: {type: duckdb}\n    prod: {type: duckdb}\n"
    )
    async with db() as session:
        proj = Project(name="proj", path=str(project_dir), platform="duckdb")
        session.add(proj)
        await session.commit()
        await session.refresh(proj)
        return proj


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[RunRequest]:
    reqs: list[RunRequest] = []

    async def _fake_stream(req: RunRequest):
        reqs.append(req)
        yield ("stdout", "hello from fake dbt")

    monkeypatch.setattr(runner, "stream", _fake_stream)
    monkeypatch.setattr(runner, "pop_return_code", lambda _pid: 0)
    return reqs


async def _settle() -> None:
    for _ in range(200):
        if not scheduler._tasks:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("scheduled fire never finished")


async def _create(client: AsyncClient, project_id: int, **body: object) -> dict:
    payload = {"name": "nightly", "command": "build -s tag:nightly", "interval_hours": 6, **body}
    r = await client.post(f"/api/projects/{project_id}/run-schedules", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


async def _backdate(db, schedule_id: int, hours: float) -> None:
    """Make a schedule look armed `hours` ago."""
    async with db() as session:
        s = await session.get(RunSchedule, schedule_id)
        s.armed_at = datetime.now(UTC) - timedelta(hours=hours)
        s.created_at = s.armed_at
        await session.commit()


# ── routes ───────────────────────────────────────────────────────────────────


async def test_create_list_and_dto(client, project) -> None:
    created = await _create(client, project.id, cron="0 7 * * 1-5", interval_hours=None, target="prod")
    assert created["cron"] == "0 7 * * 1-5"
    assert created["target"] == "prod"
    assert created["busy_wait_minutes"] == 30 and created["catch_up"] is False
    assert created["description"] == "cron 0 7 * * 1-5"
    assert created["next_run_at"] is not None
    r = await client.get(f"/api/projects/{project.id}/run-schedules")
    assert r.json()["paused"] is False
    assert [s["name"] for s in r.json()["items"]] == ["nightly"]


@pytest.mark.parametrize(("body", "field"), [
    ({"command": "init"}, "command"),
    ({"command": "docs serve"}, "command"),
    ({"cron": "* * * * *", "interval_hours": None}, "cron"),
    ({"cron": "0 7 * * *"}, "cron"),  # both an interval and a cron
    ({"target": "staging"}, "target"),
])
async def test_create_validation(client, project, body, field) -> None:
    payload = {"name": "x", "command": "build", "interval_hours": 6, **body}
    r = await client.post(f"/api/projects/{project.id}/run-schedules", json=payload)
    assert r.status_code == 400
    assert r.json()["detail"]["field"] == field


async def test_interval_and_busy_wait_bounds(client, project) -> None:
    base = {"name": "x", "command": "build"}
    assert (await client.post(f"/api/projects/{project.id}/run-schedules", json={**base, "interval_hours": 0})).status_code == 422
    assert (await client.post(f"/api/projects/{project.id}/run-schedules",
                              json={**base, "busy_wait_minutes": 721})).status_code == 422


async def test_command_target_reported(client, project) -> None:
    created = await _create(client, project.id, command="build --target prod")
    assert created["has_command_target"] is True and created["command_target"] == "prod"


async def test_patch_and_rearm(client, project, db) -> None:
    created = await _create(client, project.id)
    await _backdate(db, created["id"], 48)
    r = await client.patch(f"/api/projects/{project.id}/run-schedules/{created['id']}",
                           json={"interval_hours": None, "cron": "0 9 * * *", "busy_wait_minutes": 0})
    assert r.status_code == 200
    assert r.json()["cron"] == "0 9 * * *" and r.json()["interval_hours"] is None
    assert r.json()["busy_wait_minutes"] == 0
    async with db() as session:
        armed = (await session.get(RunSchedule, created["id"])).armed_at
    assert datetime.now(UTC) - armed.replace(tzinfo=UTC) < timedelta(minutes=1)


async def test_no_cap_on_schedules(client, project) -> None:
    for i in range(30):
        await _create(client, project.id, name=f"s{i}")
    assert len((await client.get(f"/api/projects/{project.id}/run-schedules")).json()["items"]) == 30


async def test_order(client, project) -> None:
    a = await _create(client, project.id, name="a")
    b = await _create(client, project.id, name="b")
    r = await client.put(f"/api/projects/{project.id}/run-schedules/order", json={"ids": [b["id"], a["id"]]})
    assert r.status_code == 204
    names = [s["name"] for s in (await client.get(f"/api/projects/{project.id}/run-schedules")).json()["items"]]
    assert names == ["b", "a"]


async def test_pause_all(client, project) -> None:
    await _create(client, project.id)
    r = await client.put(f"/api/projects/{project.id}/run-schedules/paused", json={"paused": True})
    assert r.json() == {"paused": True}
    listed = (await client.get(f"/api/projects/{project.id}/run-schedules")).json()
    assert listed["paused"] is True and listed["items"][0]["next_run_at"] is None


async def test_delete_unlinks_runs(client, project, db) -> None:
    created = await _create(client, project.id)
    async with db() as session:
        session.add(RunInvocation(project_id=project.id, command="build", status="success",
                                  trigger="schedule", schedule_id=created["id"]))
        await session.commit()
    r = await client.delete(f"/api/projects/{project.id}/run-schedules/{created['id']}")
    assert r.status_code == 204
    async with db() as session:
        inv = (await session.execute(select(RunInvocation))).scalar_one()
    assert inv.schedule_id is None and inv.trigger == "schedule"


async def test_unknown_schedule_404(client, project) -> None:
    assert (await client.patch(f"/api/projects/{project.id}/run-schedules/99", json={})).status_code == 404


async def test_schedule_preview_route(client) -> None:
    r = await client.get("/api/schedule-preview", params={"expr": "0 9 * * 1-5"})
    assert r.status_code == 200 and len(r.json()["next"]) == 3
    bad = await client.get("/api/schedule-preview", params={"expr": "*/5 * * * *"})
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "invalid_schedule"


# ── scheduler ────────────────────────────────────────────────────────────────


async def test_tick_runs_due_schedule(client, project, db, captured) -> None:
    created = await _create(client, project.id, target="prod")
    await _backdate(db, created["id"], 6.01)
    queue = await bus.subscribe(f"project:{project.id}")
    try:
        started = await scheduler.tick(datetime.now(UTC))
        assert started == [created["id"]]
        await _settle()
        types = []
        while not queue.empty():
            types.append((await queue.get()).type)
    finally:
        await bus.unsubscribe(f"project:{project.id}", queue)
    assert "run_schedules_changed" in types
    assert captured[0].trigger == "schedule" and captured[0].schedule_id == created["id"]
    assert captured[0].extra[-2:] == ("--target", "prod")
    async with db() as session:
        inv = (await session.execute(select(RunInvocation))).scalar_one()
        s = await session.get(RunSchedule, created["id"])
        events = (await session.execute(select(RunScheduleEvent))).scalars().all()
    assert inv.trigger == "schedule" and inv.schedule_id == created["id"] and inv.target == "prod"
    assert s.last_status == "success" and s.last_invocation_id == inv.id and s.last_fired_at is not None
    assert [(e.outcome, e.invocation_id) for e in events] == [("success", inv.id)]
    # not due again on the next tick
    assert await scheduler.tick(datetime.now(UTC)) == []


async def test_tick_records_missed_without_catch_up(client, project, db, captured) -> None:
    created = await _create(client, project.id)
    await _backdate(db, created["id"], 9)
    assert await scheduler.tick(datetime.now(UTC)) == []
    async with db() as session:
        s = await session.get(RunSchedule, created["id"])
        event = (await session.execute(select(RunScheduleEvent))).scalar_one()
    assert s.last_status == "missed" and event.outcome == "missed"
    assert captured == []


async def test_tick_catch_up_runs(client, project, db, captured) -> None:
    created = await _create(client, project.id, catch_up=True)
    await _backdate(db, created["id"], 30)
    assert await scheduler.tick(datetime.now(UTC)) == [created["id"]]
    await _settle()
    assert len(captured) == 1


async def test_paused_disabled_and_ignored_never_fire(client, project, db, captured) -> None:
    a = await _create(client, project.id, name="a")
    b = await _create(client, project.id, name="b", enabled=False)
    await _backdate(db, a["id"], 6.01)
    await _backdate(db, b["id"], 6.01)
    await client.put(f"/api/projects/{project.id}/run-schedules/paused", json={"paused": True})
    assert await scheduler.tick(datetime.now(UTC)) == []
    async with db() as session:
        p = await session.get(Project, project.id)
        p.schedules_paused, p.ignored = False, True
        await session.commit()
    assert await scheduler.tick(datetime.now(UTC)) == []


async def test_busy_runner_skips_after_wait(client, project, db, captured, monkeypatch) -> None:
    created = await _create(client, project.id, busy_wait_minutes=0)
    await _backdate(db, created["id"], 6.01)
    monkeypatch.setattr(runner, "is_project_busy", lambda _pid: True)
    await scheduler.tick(datetime.now(UTC))
    await _settle()
    async with db() as session:
        s = await session.get(RunSchedule, created["id"])
        event = (await session.execute(select(RunScheduleEvent))).scalar_one()
    assert s.last_status == "skipped_busy" and event.outcome == "skipped_busy"
    assert captured == []


async def test_wait_for_runner_retries_until_free(monkeypatch) -> None:
    calls = iter([True, True, False])
    monkeypatch.setattr(runner, "is_project_busy", lambda _pid: next(calls))
    monkeypatch.setattr(scheduler, "BUSY_POLL_S", 0.001)
    assert await scheduler.wait_for_runner(1, 5) is True


async def test_wait_for_runner_times_out(monkeypatch) -> None:
    monkeypatch.setattr(runner, "is_project_busy", lambda _pid: True)
    monkeypatch.setattr(scheduler, "BUSY_POLL_S", 0.001)
    assert await scheduler.wait_for_runner(1, 0.01) is False


async def test_invalid_command_at_fire_time(client, project, db, captured) -> None:
    created = await _create(client, project.id)
    async with db() as session:
        s = await session.get(RunSchedule, created["id"])
        s.command = "init"  # e.g. edited in the DB, or a rule tightened since it was saved
        await session.commit()
    await _backdate(db, created["id"], 6.01)
    await scheduler.tick(datetime.now(UTC))
    await _settle()
    async with db() as session:
        event = (await session.execute(select(RunScheduleEvent))).scalar_one()
    assert event.outcome == "invalid" and "init" in event.message
    assert captured == []


async def test_one_pending_per_schedule(client, project, db, captured, monkeypatch) -> None:
    created = await _create(client, project.id)
    await _backdate(db, created["id"], 6.01)
    scheduler._pending.add(created["id"])
    assert await scheduler.tick(datetime.now(UTC)) == []
    r = await client.post(f"/api/projects/{project.id}/run-schedules/{created['id']}/run")
    assert r.status_code == 409


async def test_run_now_and_history(client, project, db, captured) -> None:
    created = await _create(client, project.id)
    r = await client.post(f"/api/projects/{project.id}/run-schedules/{created['id']}/run")
    assert r.status_code == 202
    await _settle()
    assert captured[0].trigger == "manual" and captured[0].schedule_id == created["id"]
    async with db() as session:
        s = await session.get(RunSchedule, created["id"])
    assert s.last_fired_at is None  # Run now doesn't move the timing
    history = (await client.get(f"/api/projects/{project.id}/run-schedules/{created['id']}/history")).json()
    assert [(h["trigger"], h["outcome"]) for h in history["items"]] == [("manual", "success")]
    runs = (await client.get(f"/api/projects/{project.id}/run-history")).json()["items"]
    assert runs[0]["trigger"] == "manual" and runs[0]["schedule_name"] == "nightly"


async def test_events_trimmed(client, project, db, captured) -> None:
    created = await _create(client, project.id)
    for _ in range(scheduler.MAX_EVENTS_PER_SCHEDULE + 3):
        await client.post(f"/api/projects/{project.id}/run-schedules/{created['id']}/run")
        await _settle()
    async with db() as session:
        count = len((await session.execute(select(RunScheduleEvent))).scalars().all())
    assert count == scheduler.MAX_EVENTS_PER_SCHEDULE


async def test_run_history_trigger_filter(client, project, db) -> None:
    async with db() as session:
        session.add_all([
            RunInvocation(project_id=project.id, command="build", status="success", trigger="manual",
                          started_at=datetime.now(UTC)),
            RunInvocation(project_id=project.id, command="build", status="success", trigger="schedule",
                          started_at=datetime.now(UTC)),
        ])
        await session.commit()
    r = await client.get(f"/api/projects/{project.id}/run-history", params={"trigger": "schedule"})
    assert [i["trigger"] for i in r.json()["items"]] == ["schedule"]
    assert (await client.get(f"/api/projects/{project.id}/run-history", params={"trigger": "x"})).status_code == 422


def test_both_schedulers_registered() -> None:
    assert {"metric_monitors", "run_schedules"} <= set(scheduler_loop.registered())


async def test_loop_isolates_failures(monkeypatch) -> None:
    seen: list[str] = []

    async def boom(_now: datetime) -> None:
        raise RuntimeError("boom")

    async def ok(_now: datetime) -> None:
        seen.append("ok")

    monkeypatch.setattr(scheduler_loop, "_ticks", {"boom": boom, "ok": ok})
    await scheduler_loop.tick_all(datetime.now(UTC))
    assert seen == ["ok"]


async def test_startup_fails_fires_left_in_flight(db, monkeypatch) -> None:
    from sqlalchemy import text

    from app.db import migrations

    async with db() as session:
        session.add(Project(id=7, name="p", path="/tmp/p", platform="duckdb"))
        session.add(RunSchedule(id=7, project_id=7, name="n", command="build", last_status="running"))
        session.add(RunScheduleEvent(schedule_id=7, at=datetime.now(UTC), outcome="pending"))
        await session.commit()
    monkeypatch.setattr(migrations, "SessionLocal", db)
    await migrations.run_migrations()
    async with db() as session:
        status = (await session.execute(text("SELECT last_status FROM run_schedules WHERE id = 7"))).scalar_one()
        outcome = (await session.execute(text("SELECT outcome FROM run_schedule_events"))).scalar_one()
    assert status == "error" and outcome == "error"
