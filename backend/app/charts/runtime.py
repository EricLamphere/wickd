"""Live boards: one `dct serve` per project, on a free 127.0.0.1 port (Phase 2 of plan 17).

Modelled on app/semantic/runtime.MetricFlowRuntime: started lazily (building the sidecar
first), stopped after IDLE_TIMEOUT_S without a `touch` and on backend shutdown, and restarted
when the project's dct environment changes (target, profile or env vars → a new fingerprint).
A server that died is started again on the next `ensure`.

The board is embedded by URL (`http://127.0.0.1:<port>/<board>/`) rather than proxied: dct's
pages use root-absolute URLs (`/static/…`, `/__livereload`) and serve has no base-path option,
so a sub-path proxy would break them. The server only listens on the loopback interface.
"""

import asyncio
import contextlib
import hashlib
import json
import re
import socket
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx

from app.charts.env import GLOBAL_FLAGS, DctContext, output_dir
from app.logging_setup import get_logger

log = get_logger(__name__)

HOST = "127.0.0.1"
STARTUP_TIMEOUT_S = 90.0
IDLE_TIMEOUT_S = 10 * 60
IDLE_CHECK_S = 30.0
STOP_TIMEOUT_S = 5.0
OUTPUT_LINES = 40
_URL_LINE = re.compile(r"URL:\s+https?://[^\s/:]+:(\d+)")



class LiveUnavailable(Exception):
    """dct serve couldn't be started (or died while starting)."""


def serve_command(ctx: DctContext, port: int, project_id: int) -> list[str]:
    cache = output_dir(project_id) / "live-cache.duckdb"
    cache.parent.mkdir(parents=True, exist_ok=True)
    return [
        str(ctx.dct), *GLOBAL_FLAGS, "serve", "--host", HOST, "--port", str(port),
        "--project-dir", str(ctx.project_path), "--cache", str(cache),
    ]


def fingerprint(ctx: DctContext) -> str:
    payload = json.dumps([str(ctx.dct), str(ctx.project_path), sorted(ctx.env.items())])
    return hashlib.sha256(payload.encode()).hexdigest()


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def parse_port(line: str) -> int | None:
    match = _URL_LINE.search(line)
    return int(match.group(1)) if match else None


@dataclass
class _Server:
    proc: asyncio.subprocess.Process
    port: int
    fingerprint: str
    last_used: float
    output: deque[str] = field(default_factory=lambda: deque(maxlen=OUTPUT_LINES))
    drains: list[asyncio.Task] = field(default_factory=list)

    @property
    def alive(self) -> bool:
        return self.proc.returncode is None


class ChartsServers:
    def __init__(self, command_factory: Callable[[DctContext, int, int], list[str]] = serve_command) -> None:
        self._command = command_factory
        self._servers: dict[int, _Server] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._idle_task: asyncio.Task | None = None

    def _lock(self, project_id: int) -> asyncio.Lock:
        return self._locks.setdefault(project_id, asyncio.Lock())

    def status(self, project_id: int) -> dict:
        server = self._servers.get(project_id)
        running = server is not None and server.alive
        return {"running": running, "port": server.port if running and server else None}

    async def ensure(self, project_id: int, ctx: DctContext) -> int:
        """The port of the project's running server, starting (or restarting) it if needed."""
        async with self._lock(project_id):
            server = self._servers.get(project_id)
            fp = fingerprint(ctx)
            if server is not None and server.alive and server.fingerprint == fp:
                server.last_used = time.monotonic()
                return server.port
            if server is not None:
                await self._stop(project_id)
            return await self._start(project_id, ctx, fp)

    def touch(self, project_id: int) -> bool:
        server = self._servers.get(project_id)
        if server is None or not server.alive:
            return False
        server.last_used = time.monotonic()
        return True

    async def stop(self, project_id: int) -> None:
        async with self._lock(project_id):
            await self._stop(project_id)

    async def stop_all(self) -> None:
        for project_id in list(self._servers):
            await self.stop(project_id)
        if self._idle_task is not None:
            self._idle_task.cancel()
            self._idle_task = None

    async def _start(self, project_id: int, ctx: DctContext, fp: str) -> int:
        requested = free_port()
        command = self._command(ctx, requested, project_id)
        try:
            proc = await asyncio.create_subprocess_exec(
                *command, cwd=str(ctx.project_path), env=ctx.env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
        except OSError as exc:
            raise LiveUnavailable(f"could not start dct serve: {exc}") from exc
        server = _Server(proc=proc, port=requested, fingerprint=fp, last_used=time.monotonic())
        self._servers[project_id] = server
        try:
            server.port = await asyncio.wait_for(self._await_ready(server, requested), timeout=STARTUP_TIMEOUT_S)
        except (TimeoutError, LiveUnavailable) as exc:
            tail = "\n".join(list(server.output)[-8:])
            await self._stop(project_id)
            reason = "dct serve didn't start in time" if isinstance(exc, TimeoutError) else str(exc)
            log.warning("dbt_charts_live_failed", project_id=project_id, reason=reason, output=tail)
            raise LiveUnavailable(f"{reason}\n{tail}".strip()) from None
        server.drains.append(asyncio.create_task(self._drain(server)))
        if self._idle_task is None or self._idle_task.done():
            self._idle_task = asyncio.create_task(self._idle_watch())
        log.info("dbt_charts_live_started", project_id=project_id, port=server.port, pid=proc.pid)
        return server.port

    async def _await_ready(self, server: _Server, requested: int) -> int:
        """Read output until dct prints its URL (it moves to the next port if ours was taken), then
        wait for the HTTP server to answer."""
        assert server.proc.stdout is not None
        port: int | None = None
        while port is None:
            raw = await server.proc.stdout.readline()
            if not raw:
                raise LiveUnavailable("dct serve exited")
            line = raw.decode(errors="replace").rstrip()
            server.output.append(line)
            port = parse_port(line)
        async with httpx.AsyncClient(timeout=2.0) as client:
            while True:
                if not server.alive:
                    raise LiveUnavailable("dct serve exited")
                with contextlib.suppress(httpx.HTTPError):
                    if (await client.get(f"http://{HOST}:{port}/")).status_code < 500:
                        return port
                await asyncio.sleep(0.25)

    async def _drain(self, server: _Server) -> None:
        assert server.proc.stdout is not None
        async for raw in server.proc.stdout:
            server.output.append(raw.decode(errors="replace").rstrip())

    async def _stop(self, project_id: int) -> None:
        server = self._servers.pop(project_id, None)
        if server is None:
            return
        if server.alive:
            server.proc.terminate()
            try:
                await asyncio.wait_for(server.proc.wait(), timeout=STOP_TIMEOUT_S)
            except TimeoutError:
                server.proc.kill()
                await server.proc.wait()
        for task in server.drains:
            task.cancel()
        log.info("dbt_charts_live_stopped", project_id=project_id)

    async def _idle_watch(self) -> None:
        while self._servers:
            await asyncio.sleep(IDLE_CHECK_S)
            now = time.monotonic()
            for project_id, server in list(self._servers.items()):
                if not server.alive or now - server.last_used >= IDLE_TIMEOUT_S:
                    log.info("dbt_charts_live_idle_stop", project_id=project_id, alive=server.alive)
                    await self.stop(project_id)


charts_servers = ChartsServers()
