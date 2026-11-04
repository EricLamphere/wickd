"""Live docs generation state per project, for the home page's combined docs.

Published on the `global` topic: the home page shows many projects at once, and one
EventSource per project would use up the browser's connection limit. In memory only, like
other in-flight run state; a restart simply reads as "idle".
"""

from dataclasses import dataclass
from typing import Literal

from app.events.bus import Event, bus

DocsRunState = Literal["queued", "generating", "done", "error"]

MAX_ERROR_CHARS = 400
FAILURE_TAIL_LINES = 5


@dataclass(frozen=True)
class DocsRun:
    state: DocsRunState
    error: str | None = None


_runs: dict[int, DocsRun] = {}


def run_of(project_id: int) -> DocsRun | None:
    return _runs.get(project_id)


def is_active(project_id: int) -> bool:
    run = _runs.get(project_id)
    return run is not None and run.state in ("queued", "generating")


def reset() -> None:
    _runs.clear()


def failure_summary(lines: list[str]) -> str:
    """The end of dbt's output, where it says what went wrong."""
    tail = [line for line in lines if line.strip()][-FAILURE_TAIL_LINES:]
    return "\n".join(tail)[-MAX_ERROR_CHARS:] or "dbt failed without any output."


async def mark(project_id: int, state: DocsRunState, error: str | None = None) -> None:
    _runs[project_id] = DocsRun(state=state, error=error)
    await bus.publish(Event(
        topic="global",
        type="workspace_docs",
        data={"project_id": project_id, "state": state, "error": error},
    ))
