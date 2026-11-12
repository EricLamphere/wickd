import asyncio
import os
import shlex
import signal
import time
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.dbt.venv import venv_dbt
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.logs.project_logger import append_project_log

log = get_logger(__name__)

# run_lines(): one output line may hold a whole result set (a metric batch prints each query's
# rows as one JSON line), far past asyncio's 64 KiB default
RUN_LINES_LIMIT = 256 * 1024 * 1024
STOP_ATTEMPTS = 5
STOP_WAIT_S = 1.0


@dataclass
class RunRequest:
    project_id: int
    project_path: Path
    command: str  # run, build, test, deps, ls
    select: str | None = None
    extra: tuple[str, ...] = ()
    env: dict[str, str] | None = None  # if None, inherits process environment
    inject_profiles_dir: bool = True  # set False when extra already contains --profiles-dir
    trigger: str = "manual"  # manual | schedule | rerun (run_started payload; plan 27)
    schedule_id: int | None = None
    invocation_id: int | None = None  # the run_invocations row, when recorded (run_started payload)


def command_line(req: RunRequest) -> str:
    """The command as a shell would need it typed, for the project log: arguments with
    spaces, newlines or quotes (e.g. MetricFlow's multi-line `--inline` SQL) are quoted.
    dbt itself is run without a shell, each argument passed as-is."""
    parts = ["dbt", req.command, *(["--select", req.select] if req.select else []), *req.extra]
    return shlex.join(parts)


# `dbt show` only reads: skip populating the relation cache, which lists every schema's relations
# first (on Athena/Glue that took over a minute before a 1-second query). Ignored before dbt 1.5.
_NO_CACHE_COMMANDS = frozenset({"show"})


def process_env(req: RunRequest) -> dict[str, str] | None:
    """The environment dbt runs with: the request's (None = inherit), plus DBT_POPULATE_CACHE=false
    for read-only commands unless the user set it themselves. Never changes `req.env`."""
    if req.command not in _NO_CACHE_COMMANDS:
        return req.env
    base = dict(os.environ if req.env is None else req.env)
    return {**base, "DBT_POPULATE_CACHE": base.get("DBT_POPULATE_CACHE", "false")}


LOCK_WAIT_LOG_S = 1.0


def _log_lock_wait(req: RunRequest, queued: float) -> None:
    """Log a long wait for the project's dbt lock (a query queued behind another dbt command)."""
    waited = time.monotonic() - queued
    if waited >= LOCK_WAIT_LOG_S:
        log.info("dbt_lock_waited", project_id=req.project_id, command=command_label(req), waited_s=round(waited, 1))


def command_label(req: RunRequest) -> str:
    """The operation's name for the UI: the command and its subcommand words, up to the first flag
    (`source freshness`, `run-operation my_macro`, `compile`)."""
    words = [req.command]
    for arg in req.extra:
        if arg.startswith("-"):
            break
        words.append(arg)
    return " ".join(words)


@dataclass(frozen=True)
class CurrentRun:
    """The streamed dbt command a project is running now (GET /activity, plan 29)."""
    command: str
    label: str
    select: str | None
    started_at: str
    invocation_id: int | None = None
    command_line: str = ""  # command_line(req): the command as typed, for copying


async def _stop(proc: asyncio.subprocess.Process) -> None:
    """Kill dbt's process group and wait for it; a child forked mid-kill gets a second kill."""
    for _ in range(STOP_ATTEMPTS):
        _kill_group(proc)
        try:
            await asyncio.wait_for(proc.wait(), STOP_WAIT_S)
            return
        except TimeoutError:
            continue
    log.warning("dbt_stop_slow", pid=proc.pid)


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


class DbtRunner:
    """Serializes dbt invocations per project (dbt is not parallel-safe in-process)."""

    def __init__(self) -> None:
        self._locks: dict[int, asyncio.Lock] = {}
        self._procs: dict[int, asyncio.subprocess.Process] = {}
        self._cancelled: set[int] = set()
        self._return_codes: dict[int, int] = {}
        self._current: dict[int, CurrentRun] = {}

    def _lock_for(self, project_id: int) -> asyncio.Lock:
        lock = self._locks.get(project_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[project_id] = lock
        return lock

    def project_lock(self, project_id: int) -> asyncio.Lock:
        """The project's lock, for tools that read the warehouse outside dbt but must not overlap
        a dbt command (dbt Charts builds: DuckDB allows one writer and blocks readers meanwhile)."""
        return self._lock_for(project_id)

    def is_busy(self) -> bool:
        """True while any project has a dbt command in flight."""
        return any(lock.locked() for lock in self._locks.values())

    def is_project_busy(self, project_id: int) -> bool:
        """True while this project has a dbt command in flight (a new one would wait)."""
        lock = self._locks.get(project_id)
        return lock is not None and lock.locked()

    def current(self, project_id: int) -> CurrentRun | None:
        """The streamed command this project is running, or None (run() calls aren't tracked:
        they aren't user-visible)."""
        return self._current.get(project_id)

    def cancel(self, project_id: int) -> bool:
        """Terminate the running dbt process for a project. Returns True if one was running."""
        proc = self._procs.get(project_id)
        if proc is None:
            return False
        self._cancelled.add(project_id)
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        return True

    def pop_cancel_flag(self, project_id: int) -> bool:
        """Returns True and clears the flag if this project was cancelled, False otherwise."""
        if project_id in self._cancelled:
            self._cancelled.discard(project_id)
            return True
        return False

    def pop_return_code(self, project_id: int) -> int | None:
        """Return and clear the exit code of the project's last stream() run, or None if unknown."""
        return self._return_codes.pop(project_id, None)

    def build_args(self, req: RunRequest) -> list[str]:
        args = [str(venv_dbt()), req.command]
        if req.inject_profiles_dir and (req.project_path / "profiles.yml").exists():
            args += ["--profiles-dir", str(req.project_path)]
        if req.select:
            args += ["--select", req.select]
        args += list(req.extra)
        return args

    async def run(self, req: RunRequest, *, timeout: float | None = None) -> tuple[int, bytes, bytes]:
        """Acquire the per-project lock and run dbt, returning (returncode, stdout, stderr).

        `timeout` (seconds) starts once the lock is held, so waiting behind another dbt command
        doesn't count; on expiry dbt is killed and TimeoutError raised.
        Does not publish bus events — use for non-user-visible commands like dbt show.
        """
        lock = self._lock_for(req.project_id)
        queued = time.monotonic()
        async with lock, asyncio.timeout(None) as deadline:
            _log_lock_wait(req, queued)
            if timeout is not None:
                deadline.reschedule(asyncio.get_running_loop().time() + timeout)
            args = self.build_args(req)
            pid = req.project_id
            append_project_log(str(req.project_path), f">>> {command_line(req)}", pid)
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(req.project_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=process_env(req),
            )
            try:
                stdout_bytes, stderr_bytes = await proc.communicate()
            except asyncio.CancelledError:
                # e.g. a caller's timeout: don't leave dbt running after the lock is released
                proc.kill()
                await proc.wait()
                append_project_log(str(req.project_path), f"<<< dbt {req.command} CANCELLED", pid)
                raise
            rc = proc.returncode or 0
            status = "OK" if rc == 0 else f"FAILED (rc={rc})"
            append_project_log(str(req.project_path), f"<<< dbt {req.command} {status}", pid)
            return rc, stdout_bytes, stderr_bytes

    async def run_lines(self, req: RunRequest) -> AsyncIterator[str]:
        """Like run(), but yields each output line (stdout and stderr merged) as dbt prints it,
        so a caller can use results that arrive before a timeout. No bus events.

        Closing the generator early (a caller's timeout, break) kills dbt before the lock is released."""
        lock = self._lock_for(req.project_id)
        queued = time.monotonic()
        async with lock:
            _log_lock_wait(req, queued)
            pid = req.project_id
            append_project_log(str(req.project_path), f">>> {command_line(req)}", pid)
            proc = await asyncio.create_subprocess_exec(
                *self.build_args(req),
                cwd=str(req.project_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=process_env(req),
                limit=RUN_LINES_LIMIT,
                start_new_session=True,  # its own process group, so stopping it stops its children too
            )
            assert proc.stdout is not None
            try:
                while raw := await proc.stdout.readline():
                    yield raw.decode(errors="replace").rstrip("\n")
                rc = await proc.wait()
            finally:
                if proc.returncode is None:  # stopped early: don't leave dbt (or its children) running
                    await _stop(proc)
                    append_project_log(str(req.project_path), f"<<< dbt {req.command} CANCELLED", pid)
            status = "OK" if rc == 0 else f"FAILED (rc={rc})"
            append_project_log(str(req.project_path), f"<<< dbt {req.command} {status}", pid)

    async def stream(self, req: RunRequest) -> AsyncIterator[tuple[str, str]]:
        lock = self._lock_for(req.project_id)
        async with lock:
            args = self.build_args(req)
            topic = f"project:{req.project_id}"
            started_at = datetime.now(UTC).isoformat()
            label = command_label(req)
            self._current[req.project_id] = CurrentRun(
                command=req.command, label=label, select=req.select, started_at=started_at,
                invocation_id=req.invocation_id, command_line=command_line(req),
            )
            ended = [False]  # set once run_finished / run_error is published
            try:
                async with aclosing(self._stream_locked(req, args, topic, started_at, label, ended)) as inner:
                    async for item in inner:
                        yield item
            finally:
                self._current.pop(req.project_id, None)
                if not ended[0]:
                    await self._publish_abandoned(req, topic)

    async def _publish_abandoned(self, req: RunRequest, topic: str) -> None:
        """The stream stopped before dbt finished (caller timeout, error or break): say so, so
        nothing keeps showing the run as in progress."""
        try:
            await bus.publish(Event(topic=topic, type="run_finished", data={
                "command": req.command,
                "select": req.select,
                "return_code": -1,
                "finished_at": datetime.now(UTC).isoformat(),
                "abandoned": True,
            }))
        except Exception as exc:  # noqa: BLE001 — best effort while unwinding
            log.warning("run_abandoned_publish_failed", project=req.project_id, error=str(exc))

    async def _stream_locked(
        self, req: RunRequest, args: list[str], topic: str, started_at: str, label: str, ended: list[bool]
    ) -> AsyncIterator[tuple[str, str]]:
        await bus.publish(
            Event(
                topic=topic,
                type="run_started",
                data={
                    "command": req.command,
                    "label": label,
                    "select": req.select,
                    "started_at": started_at,
                    "trigger": req.trigger,
                    "schedule_id": req.schedule_id,
                    "invocation_id": req.invocation_id,
                    "command_line": command_line(req),
                },
            )
        )
        log.info("dbt_invoke", project=req.project_id, args=args, cwd=str(req.project_path))
        pid = req.project_id
        append_project_log(str(req.project_path), f">>> {command_line(req)}", pid)
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(req.project_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=process_env(req),
            )
        except FileNotFoundError:
            await bus.publish(
                Event(
                    topic=topic,
                    type="run_error",
                    data={"message": "dbt executable not found on PATH"},
                )
            )
            ended[0] = True
            append_project_log(str(req.project_path), "ERROR: dbt executable not found on PATH", pid)
            self._return_codes[pid] = 127
            yield ("stderr", "dbt executable not found on PATH\n")
            return

        self._procs[req.project_id] = proc
        assert proc.stdout is not None
        try:
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    break
                line = raw.decode(errors="replace").rstrip("\n")
                await bus.publish(
                    Event(topic=topic, type="run_log", data={"line": line})
                )
                append_project_log(str(req.project_path), line, pid)
                yield ("stdout", line)
        finally:
            self._procs.pop(req.project_id, None)
        return_code = await proc.wait()
        self._return_codes[pid] = return_code
        finished_at = datetime.now(UTC).isoformat()
        await bus.publish(
            Event(
                topic=topic,
                type="run_finished",
                data={
                    "command": req.command,
                    "select": req.select,
                    "return_code": return_code,
                    "finished_at": finished_at,
                },
            )
        )
        ended[0] = True
        status = "OK" if return_code == 0 else f"FAILED (rc={return_code})"
        append_project_log(str(req.project_path), f"<<< dbt {req.command} {status}", pid)


runner = DbtRunner()
