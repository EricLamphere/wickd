"""The long-lived MetricFlow worker process (one for all projects).

Modelled on app/ai/runtime.LlamaServer: started lazily on the first request (building
the sidecar venv first if needed), stopped after IDLE_TIMEOUT_S without a request and
on backend shutdown. Requests are JSON lines (see worker_main.py), matched to replies
by id, so several can be in flight. If the worker dies mid-request it's restarted once
and the request retried.
"""

import asyncio
import itertools
import json
import time
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import sidecar_env

log = get_logger(__name__)

WORKER_SCRIPT = Path(__file__).with_name("worker_main.py")
STARTUP_TIMEOUT_S = 60.0
REQUEST_TIMEOUT_S = 30.0
IDLE_TIMEOUT_S = 10 * 60
IDLE_CHECK_S = 30.0
STOP_TIMEOUT_S = 5.0
STDERR_LINES = 40
ENV_TOPIC = "global"
ENV_EVENT = "metricflow_env"

CommandFactory = Callable[[], Awaitable[list[str]]]


class RuntimeUnavailable(Exception):
    """The sidecar couldn't be built or the worker couldn't start."""


class WorkerRequestError(Exception):
    """The worker answered with an error (bad query, unreadable manifest …)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _WorkerDied(Exception):
    pass


async def _publish_env(state: str, phase: str, message: str) -> None:
    await bus.publish(Event(topic=ENV_TOPIC, type=ENV_EVENT, data={"state": state, "phase": phase, "message": message}))


async def default_command() -> list[str]:
    """Build the sidecar if needed (publishing progress), then the worker command line."""
    loop = asyncio.get_running_loop()

    def progress(phase: str, message: str) -> None:
        asyncio.run_coroutine_threadsafe(_publish_env("installing", phase, message), loop)

    if sidecar_env.status().state != "ready":
        try:
            python = await asyncio.to_thread(sidecar_env.ensure_sidecar, progress)
        except sidecar_env.SidecarUnavailable as exc:
            await _publish_env("error", "error", str(exc))
            raise RuntimeUnavailable(str(exc)) from exc
        await _publish_env("ready", "ready", f"MetricFlow {sidecar_env.ENGINE_VERSION} is ready")
    else:
        python = sidecar_env.venv_python()
    return [str(python), "-I", str(WORKER_SCRIPT)]


class MetricFlowRuntime:
    def __init__(self, command_factory: CommandFactory = default_command) -> None:
        self._command_factory = command_factory
        self._lock = asyncio.Lock()
        self._proc: asyncio.subprocess.Process | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._stderr: deque[str] = deque(maxlen=STDERR_LINES)
        self._last_used = 0.0
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._idle_task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self._alive()

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def request(self, op: str, payload: dict[str, Any] | None = None, *, timeout: float = REQUEST_TIMEOUT_S) -> dict:
        """Send one request and return its `result`; raises WorkerRequestError on an error reply."""
        for attempt in range(2):
            proc = await self._ensure()
            try:
                return await self._send(proc, op, payload or {}, timeout)
            except _WorkerDied:
                if attempt == 1:
                    raise RuntimeUnavailable(self._failure_message("the MetricFlow worker exited")) from None
                log.warning("metricflow_worker_restarting", op=op)
        raise AssertionError("unreachable")

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _ensure(self) -> asyncio.subprocess.Process:
        async with self._lock:
            self._last_used = time.monotonic()
            if self._alive():
                assert self._proc is not None
                return self._proc
            await self._stop_locked()
            return await self._start_locked()

    async def _start_locked(self) -> asyncio.subprocess.Process:
        command = await self._command_factory()
        self._stderr.clear()
        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=16 * 1024 * 1024,
            )
        except OSError as exc:
            raise RuntimeUnavailable(f"could not start the MetricFlow worker: {exc}") from exc
        self._stderr_task = asyncio.create_task(self._drain_stderr(proc))
        assert proc.stdout is not None
        try:
            ready = await asyncio.wait_for(proc.stdout.readline(), timeout=STARTUP_TIMEOUT_S)
        except TimeoutError:
            ready = b""
        if not ready:
            self._proc = proc
            await self._stop_locked()
            raise RuntimeUnavailable(self._failure_message("the MetricFlow worker didn't start"))
        self._proc = proc
        self._reader_task = asyncio.create_task(self._read_replies(proc))
        if self._idle_task is None or self._idle_task.done():
            self._idle_task = asyncio.create_task(self._idle_watch())
        log.info("metricflow_worker_ready", pid=proc.pid)
        return proc

    async def _send(self, proc: asyncio.subprocess.Process, op: str, payload: dict, timeout: float) -> dict:
        req_id = str(next(self._ids))
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = future
        assert proc.stdin is not None
        try:
            proc.stdin.write((json.dumps({**payload, "id": req_id, "op": op}) + "\n").encode())
            await proc.stdin.drain()
            reply = await asyncio.wait_for(future, timeout=timeout)
        except (BrokenPipeError, ConnectionResetError):
            raise _WorkerDied() from None
        except TimeoutError:
            raise WorkerRequestError("timeout", f"MetricFlow took longer than {timeout:.0f}s") from None
        finally:
            self._pending.pop(req_id, None)
            self._last_used = time.monotonic()
        if reply.get("ok"):
            return reply.get("result") or {}
        error = reply.get("error") or {}
        raise WorkerRequestError(str(error.get("code") or "internal"), str(error.get("message") or "MetricFlow failed"))

    async def _read_replies(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            try:
                reply = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("metricflow_worker_bad_line", line=raw[:200].decode(errors="replace"))
                continue
            future = self._pending.get(str(reply.get("id")))
            if future is not None and not future.done():
                future.set_result(reply)
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(_WorkerDied())

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            self._stderr.append(raw.decode(errors="replace").rstrip())

    def _failure_message(self, summary: str) -> str:
        tail = "\n".join(list(self._stderr)[-5:])
        log.warning("metricflow_worker_failed", summary=summary, stderr=tail)
        return f"{summary}: {tail}" if tail else summary

    async def _stop_locked(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        if proc.returncode is None:
            if proc.stdin is not None:
                proc.stdin.close()
            try:
                await asyncio.wait_for(proc.wait(), timeout=STOP_TIMEOUT_S)
            except TimeoutError:
                proc.kill()
                await proc.wait()
            log.info("metricflow_worker_stopped")
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()

    async def _idle_watch(self) -> None:
        while True:
            await asyncio.sleep(IDLE_CHECK_S)
            async with self._lock:
                if not self._alive():
                    return
                if not self._pending and time.monotonic() - self._last_used >= IDLE_TIMEOUT_S:
                    log.info("metricflow_worker_idle_stop")
                    await self._stop_locked()
                    return


metricflow_runtime = MetricFlowRuntime()
