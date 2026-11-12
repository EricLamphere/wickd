import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import init as init_api
from app.api import workspace_docs
from app.config import settings
from app.db import engine as db_engine
from app.db.engine import get_session
from app.db.models import (
    AppSetting,
    GlobalEnvVar,
    GlobalProfile,
    GlobalProfileVar,
    InitStep,
    Project,
    ProjectEnvVar,
)
from app.events.bus import bus
from app.main import app
from app.projects import docs_state


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def test_db_sessions(monkeypatch):
    """Point db_engine.SessionLocal at the in-memory test DB: without this, seeding and
    background writers would hit the real data/wickd.sqlite."""
    get_test_session = app.dependency_overrides[get_session]

    class TestSession:
        async def __aenter__(self):
            self._gen = get_test_session()
            return await anext(self._gen)

        async def __aexit__(self, *exc):
            await self._gen.aclose()

    monkeypatch.setattr(db_engine, "SessionLocal", TestSession)


@pytest.fixture(autouse=True)
def clean_state(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    docs_state.reset()
    yield
    docs_state.reset()


@pytest.fixture(autouse=True)
def no_real_init_pipeline(request, monkeypatch):
    """Generation runs the init pipeline first; tests about the pipeline itself opt out."""
    if "real_init" in request.keywords:
        # Commands are stubbed, but looking up the binaries raises where dbt isn't installed (CI)
        monkeypatch.setattr(init_api, "venv_dbt", lambda: Path("dbt"))
        monkeypatch.setattr(init_api, "venv_pip", lambda: Path("pip"))
        return
    monkeypatch.setattr(workspace_docs, "run_init_for_docs", AsyncMock(return_value=None))


async def _project(name: str, tmp_path: Path, ignored: bool = False) -> int:
    async with db_engine.SessionLocal() as session:
        row = Project(name=name, path=str(tmp_path / name), platform="duckdb", ignored=ignored)
        session.add(row)
        await session.commit()
        return row.id


def _write_docs(tmp_path: Path, project_id: int) -> None:
    d = tmp_path / "docs" / str(project_id)
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"metadata": {"project_name": "x"}, "nodes": {}}))
    (d / "catalog.json").write_text(json.dumps({"nodes": {}}))


async def test_lists_active_projects_with_docs_state_and_empty_selection(client, tmp_path):
    with_docs = await _project("with_docs", tmp_path)
    without = await _project("without", tmp_path)
    await _project("hidden", tmp_path, ignored=True)
    _write_docs(tmp_path, with_docs)

    res = await client.get("/api/workspace/docs")

    assert res.status_code == 200
    body = res.json()
    assert body["selection"] == []
    by_id = {p["id"]: p for p in body["projects"]}
    assert set(by_id) == {with_docs, without}
    assert by_id[with_docs]["generated_at"] is not None
    assert by_id[without]["generated_at"] is None
    assert by_id[without]["state"] == "idle"


async def test_selection_round_trips_and_dedupes_keeping_order(client, tmp_path):
    a = await _project("a", tmp_path)
    b = await _project("b", tmp_path)

    res = await client.put("/api/workspace/docs/selection", json={"project_ids": [b, a, b]})

    assert res.status_code == 200
    assert res.json()["project_ids"] == [b, a]
    assert (await client.get("/api/workspace/docs")).json()["selection"] == [b, a]


async def test_selection_rejects_unknown_projects(client, tmp_path):
    a = await _project("a", tmp_path)
    res = await client.put("/api/workspace/docs/selection", json={"project_ids": [a, 9999]})
    assert res.status_code == 400
    assert "9999" in res.json()["detail"]


async def test_selection_hides_projects_ignored_later(client, tmp_path):
    a = await _project("a", tmp_path)
    b = await _project("b", tmp_path)
    await client.put("/api/workspace/docs/selection", json={"project_ids": [a, b]})
    async with db_engine.SessionLocal() as session:
        (await session.get(Project, b)).ignored = True
        await session.commit()

    assert (await client.get("/api/workspace/docs")).json()["selection"] == [a]


async def test_corrupt_saved_selection_reads_as_empty(client, tmp_path):
    await _project("a", tmp_path)
    async with db_engine.SessionLocal() as session:
        session.add(AppSetting(key=workspace_docs.SELECTION_KEY, value="{not json"))
        await session.commit()

    assert (await client.get("/api/workspace/docs")).json()["selection"] == []


async def test_generate_runs_projects_one_at_a_time_and_reports_failures(client, tmp_path):
    a = await _project("a", tmp_path)
    b = await _project("b", tmp_path)
    running = 0
    peak = 0
    order: list[int] = []

    async def fake_generate(project_id: int, path: str, env: dict | None = None):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        order.append(project_id)
        await asyncio.sleep(0)
        running -= 1
        if project_id == a:
            raise RuntimeError("dbt exploded")
        return True, []

    queue = await bus.subscribe("global")
    try:
        with patch.object(workspace_docs, "_generate_docs", side_effect=fake_generate):
            res = await client.post("/api/workspace/docs/generate", json={"project_ids": [a, b]})
            assert res.status_code == 202
            assert res.json()["queued"] == [a, b]
            await workspace_docs.wait_for_generation()
    finally:
        await bus.unsubscribe("global", queue)

    assert order == [a, b]  # one failure doesn't stop the rest
    assert peak == 1
    by_id = {p["id"]: p for p in (await client.get("/api/workspace/docs")).json()["projects"]}
    assert by_id[a]["state"] == "error"
    assert "dbt exploded" in by_id[a]["error"]


async def test_generate_skips_projects_already_queued(client, tmp_path):
    a = await _project("a", tmp_path)
    await docs_state.mark(a, "generating")

    with patch.object(workspace_docs, "_generate_docs", new=AsyncMock()) as generate:
        res = await client.post("/api/workspace/docs/generate", json={"project_ids": [a]})
        await workspace_docs.wait_for_generation()

    assert res.json()["queued"] == []
    generate.assert_not_called()


async def test_generate_rejects_unknown_projects(client):
    res = await client.post("/api/workspace/docs/generate", json={"project_ids": [404]})
    assert res.status_code == 400


async def test_mark_publishes_a_global_event():
    queue = await bus.subscribe("global")
    try:
        await docs_state.mark(7, "error", "boom")
        event = await asyncio.wait_for(queue.get(), timeout=2)
    finally:
        await bus.unsubscribe("global", queue)
    assert event.type == "workspace_docs"
    assert event.data == {"project_id": 7, "state": "error", "error": "boom"}


async def test_docs_data_still_merges_manifest_and_catalog(client, tmp_path):
    pid = await _project("a", tmp_path)
    d = tmp_path / "docs" / str(pid)
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({
        "metadata": {"project_name": "shop", "adapter_type": "duckdb"},
        "nodes": {"model.shop.orders": {
            "name": "orders", "resource_type": "model",
            "columns": {"id": {"description": "pk"}},
        }},
    }))
    (d / "catalog.json").write_text(json.dumps({"nodes": {"model.shop.orders": {
        "metadata": {"type": "BASE TABLE"},
        "columns": {"id": {"type": "INTEGER", "index": 1}},
    }}}))

    body = (await client.get(f"/api/projects/{pid}/docs/data")).json()

    assert body["project_name"] == "shop"
    assert body["nodes"][0]["columns"][0] == {
        "name": "id", "description": "pk", "data_type": "INTEGER", "meta": {}, "tags": [],
        "constraints": [], "tests": [],
    }


async def test_docs_data_404_before_generation(client, tmp_path):
    pid = await _project("a", tmp_path)
    assert (await client.get(f"/api/projects/{pid}/docs/data")).status_code == 404


async def _profile(name: str, **variables: str) -> int:
    async with db_engine.SessionLocal() as session:
        row = GlobalProfile(name=name)
        session.add(row)
        await session.flush()
        session.add_all(GlobalProfileVar(profile_id=row.id, key=k, value=v) for k, v in variables.items())
        await session.commit()
        return row.id


async def _project_vars(project_id: int, **variables: str) -> None:
    async with db_engine.SessionLocal() as session:
        session.add_all(ProjectEnvVar(project_id=project_id, key=k, value=v) for k, v in variables.items())
        await session.commit()


async def _generate_capturing_env(client, project_id: int) -> dict:
    captured: dict = {}

    async def fake_generate(pid: int, path: str, env: dict | None = None):
        captured.update(env or {})
        return True, []

    with patch.object(workspace_docs, "_generate_docs", side_effect=fake_generate):
        await client.post("/api/workspace/docs/generate", json={"project_ids": [project_id]})
        await workspace_docs.wait_for_generation()
    return captured


async def test_profile_round_trips_and_clears(client):
    profile_id = await _profile("dev")
    assert (await client.get("/api/workspace/docs/profile")).json() == {"profile_id": None}

    res = await client.put("/api/workspace/docs/profile", json={"profile_id": profile_id})
    assert res.status_code == 200
    assert (await client.get("/api/workspace/docs/profile")).json() == {"profile_id": profile_id}

    await client.put("/api/workspace/docs/profile", json={"profile_id": None})
    assert (await client.get("/api/workspace/docs/profile")).json() == {"profile_id": None}


async def test_profile_rejects_unknown_id(client):
    res = await client.put("/api/workspace/docs/profile", json={"profile_id": 404})
    assert res.status_code == 404


async def test_deleted_profile_reads_as_none(client):
    profile_id = await _profile("dev")
    await client.put("/api/workspace/docs/profile", json={"profile_id": profile_id})
    await client.delete(f"/api/global-profiles/{profile_id}")
    assert (await client.get("/api/workspace/docs/profile")).json() == {"profile_id": None}


async def test_selecting_a_profile_leaves_each_projects_own_choice_alone(client, tmp_path):
    pid = await _project("a", tmp_path)
    own = await _profile("own")
    home = await _profile("home")
    await client.put(f"/api/projects/{pid}/active-global-profile", json={"profile_id": own})

    await client.put("/api/workspace/docs/profile", json={"profile_id": home})

    assert (await client.get(f"/api/projects/{pid}/active-global-profile")).json() == {"profile_id": own}


async def test_generate_layers_home_profile_under_project_vars(client, tmp_path):
    pid = await _project("a", tmp_path)
    own = await _profile("own", FROM_PROFILE="own", ONLY_OWN="1")
    home = await _profile("home", FROM_PROFILE="home", OVERRIDDEN="home", ONLY_HOME="1")
    await client.put(f"/api/projects/{pid}/active-global-profile", json={"profile_id": own})
    await client.put("/api/workspace/docs/profile", json={"profile_id": home})
    await _project_vars(pid, OVERRIDDEN="project", FROM_PROJECT="1")
    async with db_engine.SessionLocal() as session:
        session.add(GlobalEnvVar(key="FROM_PROFILE", value="global"))
        session.add(GlobalEnvVar(key="FROM_GLOBAL", value="1"))
        await session.commit()

    env = await _generate_capturing_env(client, pid)

    assert env["FROM_PROFILE"] == "home"
    assert env["ONLY_HOME"] == "1"
    assert "ONLY_OWN" not in env  # the home profile replaces the project's, it isn't merged
    assert env["OVERRIDDEN"] == "project"
    assert env["FROM_PROJECT"] == "1"
    assert env["FROM_GLOBAL"] == "1"


async def test_generate_without_home_profile_uses_the_projects_own(client, tmp_path):
    pid = await _project("a", tmp_path)
    own = await _profile("own", ONLY_OWN="1")
    await client.put(f"/api/projects/{pid}/active-global-profile", json={"profile_id": own})

    env = await _generate_capturing_env(client, pid)

    assert env["ONLY_OWN"] == "1"


async def test_generate_runs_init_first_with_the_home_profile(client, tmp_path):
    pid = await _project("a", tmp_path)
    home = await _profile("home")
    await client.put("/api/workspace/docs/profile", json={"profile_id": home})
    calls: list[str] = []
    workspace_docs.run_init_for_docs.side_effect = lambda *_a, **_k: calls.append("init")

    async def fake_generate(pid_: int, path: str, env: dict | None = None):
        calls.append("docs")
        return True, []

    with patch.object(workspace_docs, "_generate_docs", side_effect=fake_generate):
        await client.post("/api/workspace/docs/generate", json={"project_ids": [pid]})
        await workspace_docs.wait_for_generation()

    assert calls == ["init", "docs"]
    workspace_docs.run_init_for_docs.assert_awaited_once_with(pid, profile_id=home)


async def test_failed_init_skips_docs_and_reports_the_step(client, tmp_path):
    a = await _project("a", tmp_path)
    b = await _project("b", tmp_path)

    async def fake_init(project_id: int, profile_id: int | None = None):
        if project_id == a:
            return init_api.InitFailure(step="custom: creds.sh", log_lines=("login refused",))
        return None

    workspace_docs.run_init_for_docs.side_effect = fake_init
    generated: list[int] = []

    async def fake_generate(pid: int, path: str, env: dict | None = None):
        generated.append(pid)
        return True, []

    with patch.object(workspace_docs, "_generate_docs", side_effect=fake_generate):
        await client.post("/api/workspace/docs/generate", json={"project_ids": [a, b]})
        await workspace_docs.wait_for_generation()

    assert generated == [b]  # one project's failed init doesn't stop the rest
    by_id = {p["id"]: p for p in (await client.get("/api/workspace/docs")).json()["projects"]}
    assert by_id[a]["state"] == "error"
    assert "custom: creds.sh" in by_id[a]["error"]
    assert "login refused" in by_id[a]["error"]


async def test_initializing_counts_as_active():
    await docs_state.mark(1, "initializing")
    assert docs_state.is_active(1)


@pytest.mark.real_init
async def test_pipeline_runs_enabled_steps_with_the_home_profile(tmp_path, monkeypatch):
    pid = await _project("a", tmp_path)
    (tmp_path / "a" / "wickd" / "init").mkdir(parents=True)
    (tmp_path / "a" / "wickd" / "init" / "creds.sh").write_text("true\n")
    home = await _profile("home", FROM_PROFILE="home", OVERRIDDEN="home")
    await _project_vars(pid, OVERRIDDEN="project")
    seen: list[tuple[list[str], dict]] = []

    async def fake_exec(cmd, cwd, env):
        seen.append((list(cmd), dict(env)))
        return 0, []

    monkeypatch.setattr(init_api, "_exec_and_capture", fake_exec)

    failure = await init_api.run_init_for_docs(pid, profile_id=home)

    assert failure is None
    assert any("creds.sh" in " ".join(cmd) for cmd, _ in seen)
    assert seen and all(env["FROM_PROFILE"] == "home" and env["OVERRIDDEN"] == "project" for _, env in seen)


@pytest.mark.real_init
async def test_pipeline_leaves_docs_generation_to_the_caller(tmp_path, monkeypatch):
    pid = await _project("a", tmp_path)
    (tmp_path / "a").mkdir()
    async with db_engine.SessionLocal() as session:
        session.add(InitStep(project_id=pid, name=init_api.DOCS_GENERATE_STEP, order=5, is_base=True, enabled=True))
        await session.commit()
    ran: list[str] = []

    async def fake_run(project_id, path, steps, profile_id=None):
        ran.extend(s.name for s in steps)

    monkeypatch.setattr(init_api, "_run_init_steps", fake_run)

    await init_api.run_init_for_docs(pid)

    assert init_api.DOCS_GENERATE_STEP not in ran


@pytest.mark.real_init
async def test_pipeline_reports_the_failed_step(tmp_path, monkeypatch):
    pid = await _project("a", tmp_path)
    (tmp_path / "a" / "wickd" / "init").mkdir(parents=True)
    (tmp_path / "a" / "wickd" / "init" / "creds.sh").write_text("false\n")

    async def fake_exec(cmd, cwd, env):
        return (1, ["login refused"]) if "creds.sh" in " ".join(cmd) else (0, [])

    monkeypatch.setattr(init_api, "_exec_and_capture", fake_exec)

    failure = await init_api.run_init_for_docs(pid)

    assert failure == init_api.InitFailure(step="custom: creds", log_lines=("login refused",))


async def test_generation_writes_the_home_page_project_log(client, tmp_path):
    from app.logs.project_logger import append_project_log
    from app.logs.workspace_logger import read_workspace_log_tail

    a = await _project("alpha", tmp_path)

    async def fake_generate(project_id: int, path: str, env: dict | None = None):
        append_project_log(path, ">>> dbt docs generate", project_id)
        return True, []

    with patch.object(workspace_docs, "_generate_docs", side_effect=fake_generate):
        await client.post("/api/workspace/docs/generate", json={"project_ids": [a]})
        await workspace_docs.wait_for_generation()

    bodies = [line.split("  ", 1)[1] for line in read_workspace_log_tail()]
    assert bodies == [
        "=== alpha: init steps + docs generate ===",
        "[alpha] >>> dbt docs generate",
        "=== alpha: finished ===",
    ]
