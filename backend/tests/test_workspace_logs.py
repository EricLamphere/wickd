"""Home page Project Logs: lines from combined docs runs only."""
import asyncio
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.events.bus import bus
from app.logs.project_logger import append_project_log, append_project_log_async
from app.logs.workspace_logger import (
    append_workspace_log,
    read_workspace_log_tail,
    workspace_log_scope,
)
from app.main import app


@pytest.fixture(autouse=True)
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    return tmp_path / "data"


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _bodies(lines: list[str]) -> list[str]:
    return [line.split("  ", 1)[1] for line in lines]


def test_project_lines_outside_a_scope_stay_out(tmp_path: Path) -> None:
    append_project_log(str(tmp_path / "proj"), ">>> dbt run")
    assert read_workspace_log_tail() == []


def test_project_lines_inside_a_scope_are_mirrored(tmp_path: Path) -> None:
    with workspace_log_scope("jaffle"):
        append_project_log(str(tmp_path / "proj"), ">>> dbt docs generate")
    append_project_log(str(tmp_path / "proj"), "after the scope")
    assert _bodies(read_workspace_log_tail()) == ["[jaffle] >>> dbt docs generate"]


async def test_scope_follows_async_writes_and_child_tasks(tmp_path: Path) -> None:
    async def child() -> None:
        append_project_log(str(tmp_path / "proj"), "from a task")

    with workspace_log_scope("a"):
        await append_project_log_async(str(tmp_path / "proj"), "from the executor")
        await asyncio.create_task(child())
    assert _bodies(read_workspace_log_tail()) == ["[a] from the executor", "[a] from a task"]


async def test_lines_are_published_on_the_global_stream() -> None:
    queue = await bus.subscribe("global")
    try:
        append_workspace_log("hello")
        while True:
            event = await asyncio.wait_for(queue.get(), timeout=2.0)
            if event.type == "workspace_log":
                break
        assert event.data["line"].endswith("  hello")
    finally:
        await bus.unsubscribe("global", queue)


async def test_endpoints_read_and_clear(client: AsyncClient) -> None:
    append_workspace_log("one")
    resp = await client.get("/api/workspace/logs/project")
    assert _bodies(resp.json()["lines"]) == ["one"]

    assert (await client.delete("/api/workspace/logs/project")).json() == {"ok": True}
    assert (await client.get("/api/workspace/logs/project")).json()["lines"] == []


async def test_api_log_endpoint_responds(client: AsyncClient) -> None:
    resp = await client.get("/api/workspace/logs/api", params={"tail": 5})
    assert resp.status_code == 200
    assert isinstance(resp.json()["lines"], list)
