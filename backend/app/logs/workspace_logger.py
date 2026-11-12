"""
The home page's Project Logs: {data_dir}/logs/wickd/workspace_logs.log.

It only fills while combined docs generation runs a project's init steps and
docs generate. Inside `workspace_log_scope(name)`, every project log line the
run writes (append_project_log) is mirrored here, prefixed with the project's
name, and published as `workspace_log` on the global stream.

The scope is a ContextVar, so it follows the generation task (and tasks it
starts) and never picks up a project's own runs happening at the same time.
"""

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path

from app.config import settings
from app.logging_setup import get_logger

log = get_logger(__name__)

LOG_NAME = "workspace_logs.log"

_scope: ContextVar[str | None] = ContextVar("workspace_log_scope", default=None)


def workspace_log_path() -> Path:
    return settings.data_dir / "logs" / "wickd" / LOG_NAME


@contextmanager
def workspace_log_scope(project_name: str) -> Iterator[None]:
    """Mirror project log lines written inside this block to the workspace log."""
    token = _scope.set(project_name)
    try:
        yield
    finally:
        _scope.reset(token)


def current_scope() -> str | None:
    return _scope.get()


def append_workspace_log(line: str) -> None:
    """Append a timestamped line and publish it on the global stream."""
    try:
        path = workspace_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S")
        formatted = f"{ts}  {line}"
        with path.open("a", encoding="utf-8") as f:
            f.write(formatted + "\n")
    except OSError as exc:
        log.warning("workspace_log_write_failed", error=str(exc))
        return
    from app.events.bus import Event, bus
    try:
        asyncio.get_running_loop().create_task(
            bus.publish(Event(topic="global", type="workspace_log", data={"line": formatted}))
        )
    except RuntimeError:
        pass  # no running loop (sync tests): the line is still in the file


def mirror_project_line(line: str) -> None:
    """Called by append_project_log: copy the line here while a combined docs run is in scope."""
    name = _scope.get()
    if name is not None:
        append_workspace_log(f"[{name}] {line}")


def read_workspace_log_tail(lines: int = 500) -> list[str]:
    path = workspace_log_path()
    if not path.exists():
        return []
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
    except OSError:
        return []


def clear_workspace_log() -> None:
    path = workspace_log_path()
    if path.exists():
        path.write_text("", encoding="utf-8")
