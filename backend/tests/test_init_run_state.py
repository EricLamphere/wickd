from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import init as init_api
from app.config import settings
from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def clear_runs():
    init_api._active_runs.clear()
    yield
    init_api._active_runs.clear()


def test_step_run_state_outside_a_run() -> None:
    assert init_api.step_run_state(1, "base: dbt deps", "success") is None


def test_step_run_state_in_a_run() -> None:
    run = init_api._ActiveRun(steps=("base: pip install", "base: dbt deps"))
    run.started.add("base: pip install")
    init_api._active_runs[1] = run
    assert init_api.step_run_state(1, "base: pip install", "running") == "running"
    # Not reached yet: its persisted status is from the previous run, so it's pending
    assert init_api.step_run_state(1, "base: dbt deps", "success") == "pending"
    # Not part of this run (disabled, or another step's single-step run)
    assert init_api.step_run_state(1, "custom: seed", "error") is None
    assert init_api.step_run_state(2, "base: pip install", "success") is None


async def test_run_is_tracked_only_while_in_flight() -> None:
    seen: list[object] = []

    async def fake_locked(project_id, _path, _steps):
        seen.append(init_api._active_runs.get(project_id))

    class Step:
        def __init__(self, name: str) -> None:
            self.name = name

    with patch.object(init_api, "_run_init_steps_locked", side_effect=fake_locked):
        await init_api._run_init_steps(7, "/tmp/x", [Step("a"), Step("b")])
    assert seen[0].steps == ("a", "b")
    assert 7 not in init_api._active_runs


async def test_run_is_cleared_when_the_run_fails() -> None:
    boom = patch.object(init_api, "_run_init_steps_locked", side_effect=RuntimeError("boom"))
    with boom, pytest.raises(RuntimeError):
        await init_api._run_init_steps(7, "/tmp/x", [])
    assert 7 not in init_api._active_runs


async def test_steps_endpoint_reports_run_state(client, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dbt_projects_path", tmp_path)
    d = tmp_path / "proj"
    d.mkdir()
    (d / "dbt_project.yml").write_text("name: proj\nprofile: p\nversion: '1.0'\n")
    pid = (await client.post("/api/projects/rescan")).json()[0]["id"]

    steps = (await client.get(f"/api/projects/{pid}/init/steps")).json()
    assert all(s["run_state"] is None for s in steps)

    names = [s["name"] for s in steps]
    init_api._active_runs[pid] = init_api._ActiveRun(steps=tuple(names))
    steps = (await client.get(f"/api/projects/{pid}/init/steps")).json()
    assert {s["run_state"] for s in steps} == {"pending"}
