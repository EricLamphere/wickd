"""Live boards: ChartsServers against a fake `dct serve` (a tiny HTTP server printing dct's URL line)."""

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

from app.charts import runtime as runtime_mod
from app.charts.env import DctContext
from app.charts.runtime import ChartsServers, LiveUnavailable, parse_port

FAKE = Path(__file__).parent / "fixtures" / "charts" / "fake_serve.py"


def _fake(ctx: DctContext, port: int, project_id: int) -> list[str]:
    return [sys.executable, str(FAKE), "--port", str(port)]


def _ctx(tmp_path: Path, target: str = "dev") -> DctContext:
    return DctContext(dct=Path("dct"), env={"DBT_TARGET": target, "PATH": "/usr/bin:/bin"}, project_path=tmp_path,
                      target=target, adapter_type="duckdb")


@pytest.fixture
async def servers():
    s = ChartsServers(command_factory=_fake)
    yield s
    await s.stop_all()


async def test_start_reuse_and_answer(servers: ChartsServers, tmp_path: Path) -> None:
    port = await servers.ensure(1, _ctx(tmp_path))
    async with httpx.AsyncClient() as client:
        assert (await client.get(f"http://127.0.0.1:{port}/sales/")).status_code == 200
    assert await servers.ensure(1, _ctx(tmp_path)) == port
    assert servers.status(1) == {"running": True, "port": port}


async def test_restarts_when_the_environment_changes(servers: ChartsServers, tmp_path: Path) -> None:
    await servers.ensure(1, _ctx(tmp_path, "dev"))
    first = servers._servers[1].proc.pid
    await servers.ensure(1, _ctx(tmp_path, "prod"))
    assert servers._servers[1].proc.pid != first


async def test_restarts_a_dead_server(servers: ChartsServers, tmp_path: Path) -> None:
    await servers.ensure(1, _ctx(tmp_path))
    proc = servers._servers[1].proc
    proc.kill()
    await proc.wait()
    assert not servers.touch(1)
    await servers.ensure(1, _ctx(tmp_path))
    assert servers._servers[1].proc.pid != proc.pid


async def test_idle_stop(servers: ChartsServers, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_mod, "IDLE_CHECK_S", 0.05)
    monkeypatch.setattr(runtime_mod, "IDLE_TIMEOUT_S", 0.1)
    await servers.ensure(1, _ctx(tmp_path))
    for _ in range(60):
        if not servers.status(1)["running"]:
            break
        await asyncio.sleep(0.05)
    assert servers.status(1) == {"running": False, "port": None}


async def test_failure_to_start_is_reported(tmp_path: Path) -> None:
    servers = ChartsServers(command_factory=lambda c, p, i: [sys.executable, "-c", "print('boom'); raise SystemExit(3)"])
    with pytest.raises(LiveUnavailable, match="boom"):
        await servers.ensure(1, _ctx(tmp_path))
    assert servers.status(1)["running"] is False


def test_parse_port() -> None:
    assert parse_port("   URL: http://localhost:9411") == 9411
    assert parse_port("   URL: http://127.0.0.1:50000/") == 50000
    assert parse_port("Starting dashboard server") is None
