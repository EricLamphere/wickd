"""
Append API request/response log lines to {data_dir}/logs/wickd/api_logs.log
and publish them as `api_log` SSE events (global stream, plus the project's).
"""

import asyncio
from datetime import UTC, datetime
from pathlib import Path

from app.logging_setup import get_logger

log = get_logger(__name__)

_api_log_path: Path | None = None


def configure_api_log(data_dir: Path) -> Path:
    """Call once at startup to set the log path. Returns the path."""
    global _api_log_path
    log_dir = data_dir / "logs" / "wickd"
    log_dir.mkdir(parents=True, exist_ok=True)
    _api_log_path = log_dir / "api_logs.log"
    return _api_log_path


def get_api_log_path() -> Path | None:
    return _api_log_path


def append_api_log(line: str, project_id: int | None = None) -> None:
    """Append a timestamped line to the API log file.

    Every line is published as an `api_log` SSE event on the global stream (the
    home page's bottom pane), and on the project's stream when project_id is given.
    """
    if _api_log_path is None:
        return
    try:
        ts = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S")
        formatted = f"{ts}  {line}"
        with _api_log_path.open("a", encoding="utf-8") as f:
            f.write(formatted + "\n")

        from app.events.bus import Event, bus
        # The project's stream (its bottom pane), and the global one (the home page's)
        topics = ["global"] if project_id is None else [f"project:{project_id}", "global"]
        try:
            loop = asyncio.get_running_loop()
            for topic in topics:
                loop.create_task(bus.publish(Event(topic=topic, type="api_log", data={"line": formatted})))
        except RuntimeError:
            pass  # No running loop — skip publish

    except OSError as exc:
        log.warning("api_log_write_failed", error=str(exc))


async def append_api_log_async(line: str, project_id: int | None = None) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, append_api_log, line, project_id)


def read_api_log_tail(lines: int = 500) -> list[str]:
    if _api_log_path is None or not _api_log_path.exists():
        return []
    try:
        text = _api_log_path.read_text(encoding="utf-8", errors="replace")
        return text.splitlines()[-lines:]
    except OSError:
        return []
