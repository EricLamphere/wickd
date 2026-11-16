"""/api/app/* (desktop updater, plan 32) and the updater settings."""
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import app_info
from app.api import init as init_api
from app.db.engine import get_session
from app.db.models import Project, RunSchedule
from app.dbt.runner import CurrentRun, runner
from app.main import app
from app.version import _from_pyproject, app_version


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def clean_state():
    init_api._active_runs.clear()
    runner._current.clear()
    yield
    init_api._active_runs.clear()
    runner._current.clear()


async def _add(*rows: object) -> list[object]:
    gen = app.dependency_overrides[get_session]()
    session = await gen.__anext__()
    try:
        session.add_all(rows)
        await session.commit()
        for row in rows:
            await session.refresh(row)
        return list(rows)
    finally:
        await gen.aclose()


async def _project(tmp_path: Path, name: str = "jaffle_shop") -> Project:
    (project,) = await _add(Project(name=name, path=str(tmp_path / name), platform="local"))
    return project  # type: ignore[return-value]


# ── info ─────────────────────────────────────────────────────────────────────


async def test_info_reports_version_and_not_desktop_from_source(client: AsyncClient) -> None:
    res = await client.get("/api/app/info")
    assert res.status_code == 200
    assert res.json() == {"version": app_version(), "desktop": False}
    assert app_version().count(".") == 2


def test_version_from_pyproject(tmp_path: Path) -> None:
    good = tmp_path / "pyproject.toml"
    good.write_text('[project]\nname = "x"\nversion = "9.8.7"\n')
    assert _from_pyproject(good) == "9.8.7"
    assert _from_pyproject(tmp_path / "missing.toml") == ""
    bad = tmp_path / "bad.toml"
    bad.write_text("[tool]\n")
    assert _from_pyproject(bad) == ""


# ── busy ─────────────────────────────────────────────────────────────────────


async def test_busy_is_false_when_idle(client: AsyncClient, tmp_path: Path) -> None:
    await _project(tmp_path)
    res = await client.get("/api/app/busy")
    assert res.json() == {"busy": False, "activities": []}


async def test_busy_lists_dbt_run_and_init(client: AsyncClient, tmp_path: Path) -> None:
    project = await _project(tmp_path)
    runner._current[project.id] = CurrentRun(command="build", label="build", select=None, started_at="now")
    init_api._active_runs[project.id] = init_api._ActiveRun(steps=("base: pip install",))
    body = (await client.get("/api/app/busy")).json()
    assert body["busy"] is True
    assert body["activities"] == [
        {"project": "jaffle_shop", "label": "dbt build"},
        {"project": "jaffle_shop", "label": "the init pipeline"},
    ]


async def test_busy_counts_global_setup(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app_info, "global_setup_running", lambda: True)
    body = (await client.get("/api/app/busy")).json()
    assert body == {"busy": True, "activities": [{"project": None, "label": "global setup"}]}


async def test_busy_counts_a_schedule_due_soon(client: AsyncClient, tmp_path: Path) -> None:
    project = await _project(tmp_path)
    now = datetime.now(UTC)
    # 1-hour interval armed 58 minutes ago → due in ~2 minutes
    await _add(
        RunSchedule(project_id=project.id, name="hourly", command="dbt build", interval_hours=1,
                    enabled=True, armed_at=now - timedelta(minutes=58),
                    created_at=now - timedelta(minutes=58)),
        RunSchedule(project_id=project.id, name="later", command="dbt build", interval_hours=1,
                    enabled=True, armed_at=now - timedelta(minutes=10),
                    created_at=now - timedelta(minutes=10)),
    )
    body = (await client.get("/api/app/busy")).json()
    assert body["activities"] == [{"project": "jaffle_shop", "label": "scheduled run 'hourly' (due in a few minutes)"}]


# ── shutdown-prep ────────────────────────────────────────────────────────────


async def test_shutdown_prep_is_idempotent(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def fake_loop_stop() -> None:
        calls.append("loop")

    async def fake_watcher_stop() -> None:
        calls.append("watcher")

    from app.watcher.service import watcher_manager

    monkeypatch.setattr(app_info.scheduler_loop, "stop", fake_loop_stop)
    monkeypatch.setattr(watcher_manager, "stop", fake_watcher_stop)
    assert (await client.post("/api/app/shutdown-prep")).status_code == 204
    assert (await client.post("/api/app/shutdown-prep")).status_code == 204
    assert calls == ["loop", "watcher", "loop", "watcher"]


# ── settings ─────────────────────────────────────────────────────────────────


async def test_update_settings_round_trip(client: AsyncClient) -> None:
    body = (await client.get("/api/settings")).json()
    assert body["update_check_enabled"] is True
    assert body["update_skipped_version"] is None

    body = (await client.put("/api/settings", json={
        "update_check_enabled": False, "update_skipped_version": "v1.4.0",
    })).json()
    assert body["update_check_enabled"] is False
    assert body["update_skipped_version"] == "1.4.0"

    body = (await client.put("/api/settings", json={"update_skipped_version": ""})).json()
    assert body["update_skipped_version"] is None
    assert body["update_check_enabled"] is False


async def test_update_skipped_version_must_be_semver(client: AsyncClient) -> None:
    res = await client.put("/api/settings", json={"update_skipped_version": "latest"})
    assert res.status_code == 400
