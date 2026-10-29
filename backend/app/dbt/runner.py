import asyncio
import shlex
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.dbt.venv import venv_dbt
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.logs.project_logger import append_project_log

log = get_logger(__name__)


@dataclass
class RunRequest:
    project_id: int
    project_path: Path
    command: str  # run, build, test, deps, ls
    select: str | None = None
    extra: tuple[str, ...] = ()
    env: dict[str, str] | None = None  # if None, inherits process environment
    inject_profiles_dir: bool = True  # set False when extra already contains --profiles-dir


def command_line(req: RunRequest) -> str:
    """The command as a shell would need it typed, for the project log: arguments with
    spaces, newlines or quotes (e.g. MetricFlow's multi-line `--inline` SQL) are quoted.
    dbt itself is run without a shell, each argument passed as-is."""
    parts = ["dbt", req.command, *(["--select", req.select] if req.select else []), *req.extra]
    return shlex.join(parts)


def command_label(req: RunRequest) -> str:
    """The operation's name for the UI: the command and its subcommand words, up to the first flag
    (`source freshness`, `run-operation my_macro`, `compile`)."""
    words = [req.command]
    for arg in req.extra:
        if arg.startswith("-"):
            break
        words.append(arg)
    return " ".join(words)


class DbtRunner:
    """Serializes dbt invocations per project (dbt is not parallel-safe in-process)."""

    def __init__(self) -> None:
        self._locks: dict[int, asyncio.Lock] = {}
        self._procs: dict[int, asyncio.subprocess.Process] = {}
        self._cancelled: set[int] = set()
        self._return_codes: dict[int, int] = {}

    def _lock_for(self, project_id: int) -> asyncio.Lock:
        lock = self._locks.get(project_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[project_id] = lock
        return lock

    def is_busy(self) -> bool:
        """True while any project has a dbt command in flight."""
        return any(lock.locked() for lock in self._locks.values())

    def is_project_busy(self, project_id: int) -> bool:
        """True while this project has a dbt command in flight (a new one would wait)."""
        lock = self._locks.get(project_id)
        return lock is not None and lock.locked()

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

    async def run(self, req: RunRequest) -> tuple[int, bytes, bytes]:
        """Acquire the per-project lock and run dbt, returning (returncode, stdout, stderr).

        Does not publish bus events — use for non-user-visible commands like dbt show.
        """
        lock = self._lock_for(req.project_id)
        async with lock:
            args = self.build_args(req)
            pid = req.project_id
            append_project_log(str(req.project_path), f">>> {command_line(req)}", pid)
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(req.project_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=req.env,
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

    async def stream(self, req: RunRequest) -> AsyncIterator[tuple[str, str]]:
        lock = self._lock_for(req.project_id)
        async with lock:
            args = self.build_args(req)
            topic = f"project:{req.project_id}"
            started_at = datetime.now(UTC).isoformat()
            await bus.publish(
                Event(
                    topic=topic,
                    type="run_started",
                    data={
                        "command": req.command,
                        "label": command_label(req),
                        "select": req.select,
                        "started_at": started_at,
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
                    env=req.env,
                )
            except FileNotFoundError:
                await bus.publish(
                    Event(
                        topic=topic,
                        type="run_error",
                        data={"message": "dbt executable not found on PATH"},
                    )
                )
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
            status = "OK" if return_code == 0 else f"FAILED (rc={return_code})"
            append_project_log(str(req.project_path), f"<<< dbt {req.command} {status}", pid)


runner = DbtRunner()
