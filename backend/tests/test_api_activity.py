"""GET /api/projects/{id}/activity — what's running now, to seed the running-status
bubble after a reload or navigation (plan 29)."""
import asyncio
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import init as init_api
from app.api import models as models_api
from app.api.activity import label_of, log_tail
from app.db.engine import get_session
from app.db.models import InvocationModelResult, Project, RunInvocation
from app.dbt.runner import CurrentRun, RunRequest, runner
from app.main import app
from app.projects import docs_state


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def fake_dbt_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests fake the subprocess, but resolving the dbt path would still build or
    require the real dbt venv, which CI doesn't have."""
    from app.dbt import runner as runner_mod
    from app.dbt import venv

    monkeypatch.setattr(runner_mod, "venv_dbt", lambda: Path("dbt"))
    monkeypatch.setattr(venv, "venv_dbt", lambda: Path("dbt"))


@pytest.fixture(autouse=True)
def clean_state():
    init_api._active_runs.clear()
    models_api._compiles_in_flight.clear()
    runner._current.clear()
    docs_state.reset()
    yield
    init_api._active_runs.clear()
    models_api._compiles_in_flight.clear()
    runner._current.clear()
    docs_state.reset()


async def _project(tmp_path: Path) -> int:
    session_gen = app.dependency_overrides[get_session]()
    session = await session_gen.__anext__()
    try:
        project = Project(name="proj", path=str(tmp_path), platform="local")
        session.add(project)
        await session.commit()
        return project.id
    finally:
        await session_gen.aclose()


async def test_unknown_project_is_404(client: AsyncClient) -> None:
    res = await client.get("/api/projects/999/activity")
    assert res.status_code == 404


async def test_idle_project(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    res = await client.get(f"/api/projects/{pid}/activity")
    assert res.status_code == 200
    assert res.json() == {"run": None, "init": None, "compile": None, "docs": None, "recent": []}


async def test_busy_runner_reports_the_current_run(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    runner._current[pid] = CurrentRun(
        command="build", label="build", select="orders+", started_at="2026-11-11T10:00:00+00:00",
        invocation_id=7, command_line="dbt build --select orders+",
    )
    res = await client.get(f"/api/projects/{pid}/activity")
    assert res.json()["run"] == {
        "command": "build",
        "label": "build",
        "select": "orders+",
        "started_at": "2026-11-11T10:00:00+00:00",
        "invocation_id": 7,
        "command_line": "dbt build --select orders+",
    }


async def test_active_init_reports_the_current_step(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    run = init_api._ActiveRun(
        steps=("base: pip install", "base: dbt deps", "custom: seed"),
        started_at="2026-11-11T10:00:00+00:00",
    )
    run.started.update({"base: pip install", "base: dbt deps"})
    init_api._active_runs[pid] = run
    res = await client.get(f"/api/projects/{pid}/activity")
    assert res.json()["init"] == {
        "steps": ["base: pip install", "base: dbt deps", "custom: seed"],
        "current_step": "base: dbt deps",
        "started": 2,
        "started_at": "2026-11-11T10:00:00+00:00",
    }


async def test_compile_and_docs_in_flight(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    models_api._compiles_in_flight[pid] = "2026-11-11T10:00:00+00:00"
    await docs_state.mark(pid, "generating")
    body = (await client.get(f"/api/projects/{pid}/activity")).json()
    assert body["compile"] == {"started_at": "2026-11-11T10:00:00+00:00"}
    assert body["docs"] == {"started_at": None}


async def test_finished_docs_run_is_not_reported(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    await docs_state.mark(pid, "done")
    body = (await client.get(f"/api/projects/{pid}/activity")).json()
    assert body["docs"] is None


async def test_runner_remembers_the_current_run_only_while_streaming(tmp_path: Path) -> None:
    """stream() sets `current` once the run starts and clears it when the run ends."""
    seen: list[CurrentRun | None] = []
    req = RunRequest(project_id=7, project_path=tmp_path, command="build", select="orders+")

    class FakeProc:
        returncode = 0

        def __init__(self) -> None:
            self.stdout = asyncio.StreamReader()
            self.stdout.feed_data(b"1 of 1 OK\n")
            self.stdout.feed_eof()

        async def wait(self) -> int:
            return 0

    async def fake_exec(*_args, **_kwargs):
        return FakeProc()

    with patch("asyncio.create_subprocess_exec", side_effect=fake_exec):
        async for _kind, _line in runner.stream(req):
            seen.append(runner.current(7))
    assert seen and seen[0] is not None
    assert seen[0].command == "build" and seen[0].select == "orders+" and seen[0].label == "build"
    assert seen[0].command_line == "dbt build --select orders+"
    assert runner.current(7) is None


async def test_compile_project_is_tracked_while_in_flight(tmp_path: Path) -> None:
    seen: list[str | None] = []

    class FakeProc:
        def __init__(self) -> None:
            self.stdout = self._lines()

        async def _lines(self):
            seen.append(models_api._compiles_in_flight.get(3))
            yield b"ok\n"

        async def wait(self) -> int:
            return 0

    async def fake_exec(*_args, **_kwargs):
        return FakeProc()

    async def fake_env(_pid):
        return {}

    with patch("asyncio.create_subprocess_exec", side_effect=fake_exec), \
         patch("app.api.init.load_project_env", side_effect=fake_env):
        ok = await models_api._compile_project(3, str(tmp_path))
    assert ok is True
    assert seen and seen[0] is not None
    assert 3 not in models_api._compiles_in_flight


async def test_queued_docs_are_not_reported_until_generating(client: AsyncClient, tmp_path: Path) -> None:
    """`queued` / `initializing` come before docs_generating; seeding them would duplicate it."""
    pid = await _project(tmp_path)
    await docs_state.mark(pid, "initializing")
    assert (await client.get(f"/api/projects/{pid}/activity")).json()["docs"] is None


async def test_stream_ending_early_still_publishes_a_terminal_event(tmp_path: Path) -> None:
    """A consumer that stops (timeout, error, break) after run_started must not leave the run
    looking like it's still going: stream() publishes run_finished with return_code -1."""
    from app.events.bus import bus

    req = RunRequest(project_id=8, project_path=tmp_path, command="run")

    class FakeProc:
        returncode = None

        def __init__(self) -> None:
            self.stdout = asyncio.StreamReader()
            self.stdout.feed_data(b"line 1\nline 2\n")

        async def wait(self) -> int:
            return 0

    async def fake_exec(*_args, **_kwargs):
        return FakeProc()

    queue = await bus.subscribe("project:8")
    try:
        with patch("asyncio.create_subprocess_exec", side_effect=fake_exec):
            gen = runner.stream(req)
            async for _item in gen:
                break
            await gen.aclose()
        types = []
        while not queue.empty():
            event = queue.get_nowait()
            types.append((event.type, event.data.get("return_code")))
        assert types[0][0] == "run_started"
        assert types[-1] == ("run_finished", -1)
        assert runner.current(8) is None
        assert 8 not in runner._procs
    finally:
        await bus.unsubscribe("project:8", queue)


async def _invocations(rows: list[RunInvocation]) -> list[int]:
    session_gen = app.dependency_overrides[get_session]()
    session = await session_gen.__anext__()
    try:
        session.add_all(rows)
        await session.commit()
        return [r.id for r in rows]
    finally:
        await session_gen.aclose()


def _inv(pid: int, status: str, cli: str, minute: int, **kw) -> RunInvocation:
    return RunInvocation(
        project_id=pid, command=cli.split()[1], cli_command=cli, status=status,
        started_at=datetime(2026, 11, 11, 10, minute, tzinfo=UTC),
        finished_at=datetime(2026, 11, 11, 10, minute, 30, tzinfo=UTC), **kw,
    )


async def test_recent_lists_the_five_newest_finished_runs(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    log = tmp_path / "run.log"
    log.write_text("".join(f"line {i}\n" for i in range(80)), encoding="utf-8")
    rows = [_inv(pid, "success", f"dbt run --select m{i}", i, selector=f"m{i}") for i in range(6)]
    rows.append(_inv(pid, "running", "dbt build", 7))
    rows.append(_inv(pid, "cancelled", "dbt source freshness --target dev", 8, log_path=str(log)))
    await _invocations(rows)
    recent = (await client.get(f"/api/projects/{pid}/activity")).json()["recent"]
    assert [r["label"] for r in recent] == ["source freshness", "run", "run", "run", "run"]
    assert [r["select"] for r in recent[1:]] == ["m5", "m4", "m3", "m2"]
    newest = recent[0]
    assert newest["status"] == "error"
    assert newest["command_line"] == "dbt source freshness --target dev"
    assert newest["started_at"].startswith("2026-11-11T10:08:00")
    assert newest["log"] == [f"line {i}" for i in range(30, 80)]
    assert recent[1]["log"] == []


async def test_recent_skips_the_run_in_flight_and_reports_warnings(client: AsyncClient, tmp_path: Path) -> None:
    pid = await _project(tmp_path)
    warned, other = await _invocations([_inv(pid, "success", "dbt test", 1), _inv(pid, "success", "dbt run", 2)])
    await _invocations([InvocationModelResult(
        invocation_id=warned, project_id=pid, unique_id="test.a", name="a", kind="test", status="warn",
    )])
    runner._current[pid] = CurrentRun(
        command="run", label="run", select=None, started_at="2026-11-11T10:02:00+00:00", invocation_id=other,
    )
    recent = (await client.get(f"/api/projects/{pid}/activity")).json()["recent"]
    assert [(r["invocation_id"], r["status"]) for r in recent] == [(warned, "warn")]


def test_label_of() -> None:
    assert label_of("dbt run-operation my_macro --args '{a: 1}'", "run-operation") == "run-operation my_macro"
    assert label_of(None, "build") == "build"
    assert label_of("dbt 'unbalanced", "run") == "'unbalanced"


def test_log_tail_reads_only_the_end(tmp_path: Path) -> None:
    log = tmp_path / "big.log"
    log.write_text("x" * 40_000 + "\nlast\n", encoding="utf-8")
    assert log_tail(str(log)) == ["last"]
    assert log_tail(str(tmp_path / "missing.log")) == []
    assert log_tail(None) == []
