"""Metric query runs in flight: progress for the UI, and cancelling them.

Every run_many() with a `kind` registers here (the metric index / pages, the query view,
dashboards, debug checks, monitors, compare). Its progress goes out on the project's stream as
`metric_queries_progress` {run_id, kind, label, done, total, finished, cancelled}, throttled; a
final one with `finished: true` always follows. Cancelling sets the run's event: its workers stop
their dbt processes, finished results are kept, the rest come back `cancelled`.
"""

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.events.bus import Event, bus
from app.logging_setup import get_logger

log = get_logger(__name__)

PROGRESS_EVENT = "metric_queries_progress"
PROGRESS_INTERVAL_S = 1.5
# what the metric pages' Cancel stops (data diffs and semantic drafts have their own controls)
METRIC_KINDS = frozenset({"metrics", "explore", "dashboard", "debug", "monitors", "compare"})


@dataclass
class ActiveRun:
    run_id: str
    project_id: int
    kind: str
    total: int
    label: str = ""
    done: int = 0
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    _published_at: float = 0.0

    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set()

    def to_dict(self, *, finished: bool = False) -> dict:
        return {
            "run_id": self.run_id, "kind": self.kind, "label": self.label, "done": self.done, "total": self.total,
            "started_at": self.started_at.isoformat(), "finished": finished, "cancelled": self.cancelled,
        }


_active: dict[int, dict[str, ActiveRun]] = {}


def active(project_id: int) -> list[ActiveRun]:
    return list(_active.get(project_id, {}).values())


async def _publish(run: ActiveRun, *, finished: bool = False) -> None:
    run._published_at = time.monotonic()
    await bus.publish(Event(topic=f"project:{run.project_id}", type=PROGRESS_EVENT, data=run.to_dict(finished=finished)))


async def start(project_id: int, kind: str, total: int, *, run_id: str | None = None, label: str = "") -> ActiveRun:
    run = ActiveRun(run_id or uuid.uuid4().hex[:12], project_id, kind, total, label)
    _active.setdefault(project_id, {})[run.run_id] = run
    await _publish(run)
    return run


async def advance(run: ActiveRun, count: int = 1) -> None:
    """`count` more queries of `run` answered; publishes at most every PROGRESS_INTERVAL_S."""
    run.done = min(run.total, run.done + count)
    if time.monotonic() - run._published_at >= PROGRESS_INTERVAL_S:
        await _publish(run)


async def finish(run: ActiveRun) -> None:
    runs = _active.get(run.project_id, {})
    runs.pop(run.run_id, None)
    if not runs:
        _active.pop(run.project_id, None)
    await _publish(run, finished=True)


def cancel(project_id: int, run_ids: list[str] | None = None, kinds: frozenset[str] = METRIC_KINDS) -> int:
    """Cancel `run_ids` (None = every run of `kinds`) of the project; how many were cancelled."""
    count = 0
    for run in active(project_id):
        wanted = run.run_id in run_ids if run_ids is not None else run.kind in kinds
        if wanted and not run.cancelled:
            run.cancel_event.set()
            count += 1
    if count:
        log.info("metric_queries_cancelled", project_id=project_id, runs=count, api_log=True)
    return count
