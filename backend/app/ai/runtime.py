"""Manage the bundled llama-server process that serves the local model.

Started lazily on the first AI request (a 3–6 GB model shouldn't sit in
memory for users who never touch AI), stopped after IDLE_TIMEOUT_S without a
request, when the model changes, and on backend shutdown. llama-server
speaks the OpenAI-compatible API, so the client is the same one used for a
user-configured endpoint (see app/ai/client.py).
"""

import asyncio
import json
import shutil
import socket
import sys
import time
from collections import deque
from pathlib import Path

import httpx

from app.ai.catalog import ModelSpec
from app.ai.download import model_path
from app.config import settings
from app.logging_setup import get_logger

log = get_logger(__name__)

BINARY_NAME = "llama-server"
HOST = "127.0.0.1"
STARTUP_TIMEOUT_S = 120.0  # loading weights from a cold disk can be slow
HEALTH_POLL_S = 0.25
IDLE_TIMEOUT_S = 10 * 60
IDLE_CHECK_S = 30.0
STDERR_LINES = 40
STOP_TIMEOUT_S = 5.0


class RuntimeUnavailable(Exception):
    """llama-server can't be found, or the model isn't downloaded / won't load."""


def _repo_runtime_dir() -> Path:
    # Where `task ai:runtime` unpacks llama.cpp; also the source the app bundle copies.
    return Path(__file__).resolve().parents[3] / "src-tauri" / "binaries" / "llama"


def _bundled_runtime_dir() -> Path:
    # Packaged app: Resources/binaries/wickd-backend/wickd-backend → Resources/binaries/llama
    return Path(sys.executable).resolve().parent.parent / "llama"


def find_llama_server() -> Path | None:
    """Explicit override, then the bundled/dev copy, then PATH (e.g. Homebrew)."""
    if settings.llama_server_path is not None:
        return settings.llama_server_path if settings.llama_server_path.is_file() else None
    frozen = getattr(sys, "frozen", False)
    runtime_dir = _bundled_runtime_dir() if frozen else _repo_runtime_dir()
    candidate = runtime_dir / BINARY_NAME
    if candidate.is_file():
        return candidate
    found = shutil.which(BINARY_NAME)
    return Path(found) if found else None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def build_args(binary: Path, spec: ModelSpec, port: int) -> list[str]:
    return [
        str(binary),
        "--model", str(model_path(spec)),
        "--host", HOST,
        "--port", str(port),
        "--ctx-size", str(spec.context_size),
        "--n-gpu-layers", "99",  # everything on the GPU (Metal on Apple Silicon)
        "--parallel", "1",  # one slot: the whole context for one request, less memory
        "--jinja",
        "--no-webui",
        "--offline",
        # Thinking burns tokens and seconds on a laptop; these features don't need it.
        "--reasoning-budget", "0",
        "--chat-template-kwargs", json.dumps({"enable_thinking": False}),
    ]


class LlamaServer:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._proc: asyncio.subprocess.Process | None = None
        self._model_id: str | None = None
        self._base_url: str | None = None
        self._stderr: deque[str] = deque(maxlen=STDERR_LINES)
        self._last_used = 0.0
        self._idle_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None

    @property
    def running_model(self) -> str | None:
        return self._model_id if self._alive() else None

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def ensure(self, spec: ModelSpec) -> str:
        """Base URL (".../v1") of a server running `spec`, starting it if needed."""
        async with self._lock:
            self._last_used = time.monotonic()
            if self._alive() and self._model_id == spec.id and self._base_url:
                return self._base_url
            await self._stop_locked()
            return await self._start_locked(spec)

    def touch(self) -> None:
        """Mark activity so a long generation doesn't count as idle."""
        self._last_used = time.monotonic()

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _start_locked(self, spec: ModelSpec) -> str:
        binary = find_llama_server()
        if binary is None:
            raise RuntimeUnavailable(
                "The local AI runtime (llama-server) isn't installed in this build."
            )
        if not model_path(spec).exists():
            raise RuntimeUnavailable(f"{spec.label} hasn't been downloaded yet.")

        port = _free_port()
        self._stderr.clear()
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *build_args(binary, spec, port),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise RuntimeUnavailable(f"could not start llama-server: {exc}") from exc
        self._stderr_task = asyncio.create_task(self._drain_stderr(self._proc))
        base = f"http://{HOST}:{port}"
        log.info("ai_runtime_starting", model=spec.id, port=port, binary=str(binary))

        try:
            await self._wait_healthy(base)
        except RuntimeUnavailable:
            await self._stop_locked()
            raise
        self._model_id = spec.id
        self._base_url = f"{base}/v1"
        if self._idle_task is None or self._idle_task.done():
            self._idle_task = asyncio.create_task(self._idle_watch())
        log.info("ai_runtime_ready", model=spec.id, port=port)
        return self._base_url

    async def _wait_healthy(self, base: str) -> None:
        deadline = time.monotonic() + STARTUP_TIMEOUT_S
        async with httpx.AsyncClient(timeout=2.0) as client:
            while time.monotonic() < deadline:
                if not self._alive():
                    raise RuntimeUnavailable(self._failure_message("llama-server exited"))
                try:
                    response = await client.get(f"{base}/health")
                    if response.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass  # not listening yet
                await asyncio.sleep(HEALTH_POLL_S)
        raise RuntimeUnavailable(self._failure_message("the model took too long to load"))

    def _failure_message(self, summary: str) -> str:
        tail = "\n".join(list(self._stderr)[-5:])
        log.warning("ai_runtime_failed", summary=summary, stderr=tail)
        return f"{summary}: {tail}" if tail else summary

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            self._stderr.append(raw.decode(errors="replace").rstrip())

    async def _stop_locked(self) -> None:
        proc, self._proc = self._proc, None
        self._model_id = None
        self._base_url = None
        if proc is None or proc.returncode is not None:
            return
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=STOP_TIMEOUT_S)
        except TimeoutError:
            proc.kill()
            await proc.wait()
        log.info("ai_runtime_stopped")

    async def _idle_watch(self) -> None:
        while True:
            await asyncio.sleep(IDLE_CHECK_S)
            async with self._lock:
                if not self._alive():
                    return
                if time.monotonic() - self._last_used >= IDLE_TIMEOUT_S:
                    log.info("ai_runtime_idle_stop")
                    await self._stop_locked()
                    return


llama_server = LlamaServer()
