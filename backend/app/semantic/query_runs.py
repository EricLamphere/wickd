"""Metric queries run in the background (the metric page and index, the query view).

A slow warehouse used to hold one HTTP request open for the whole `dbt show` (minutes), which
the desktop webview could drop ("Load failed"). Now Run answers at once: the queries without a
stored result start here, their requests report `running`, and `metric_queries_finished` on the
project's stream tells the page to read them again — stored results, or the failure kept here.

Keyed by CacheKey (target + env + SQL), the same key as the result cache, so a query already
running isn't started twice, whoever asks. Failures are kept for FAILURE_TTL_S, so a refetch
shows the error instead of running the failing query again; Run / Refresh runs it anyway.

Each result is stored the moment it arrives (run_many's on_result), so a refetch on
`metric_queries_progress` shows the queries finished so far. A cancelled run's unanswered
queries are forgotten (`not_run` again), not failed.
"""

import asyncio
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import query_cache
from app.semantic.batch import BatchResult, run_many
from app.semantic.query_cache import CacheKey
from app.semantic.query_service import QueryContext

log = get_logger(__name__)

FINISHED_EVENT = "metric_queries_finished"
FAILURE_TTL_S = 10 * 60
MAX_FAILURES = 500
# a background run can wait longer for the project's other dbt command than a request could
LOCK_WAIT_S = 15 * 60.0


@dataclass(frozen=True)
class PendingQuery:
    key: CacheKey
    sql: str
    metrics: tuple[str, ...] = ()
    group_by: tuple[str, ...] = ()


@dataclass(frozen=True)
class Failure:
    error: str
    failed_at: float  # time.monotonic()


RUNNING = "running"

_running: dict[CacheKey, str] = {}  # key → run id
_failures: OrderedDict[CacheKey, Failure] = OrderedDict()
_tasks: set[asyncio.Task] = set()


def status(key: CacheKey) -> str | Failure | None:
    """RUNNING, the recent failure, or None (never run here, or the failure expired)."""
    if key in _running:
        return RUNNING
    failure = _failures.get(key)
    if failure and time.monotonic() - failure.failed_at > FAILURE_TTL_S:
        _failures.pop(key, None)
        return None
    return failure


def _remember_failure(key: CacheKey, error: str) -> None:
    _failures[key] = Failure(error, time.monotonic())
    _failures.move_to_end(key)
    while len(_failures) > MAX_FAILURES:
        _failures.popitem(last=False)


@dataclass
class _Group:
    """Queries started within COALESCE_S of each other for one project + context: one run."""
    run_id: str
    project_path: Path
    queries: list[PendingQuery]


# Run all sends its queries in several requests a moment apart: they become one run, so dbt
# starts once per worker instead of once per worker per request
COALESCE_S = 0.5
_open: dict[tuple[int, QueryContext, str], _Group] = {}


def start(
    project_id: int, project_path: Path, queries: list[PendingQuery], ctx: QueryContext, *, kind: str = "metrics",
) -> str | None:
    """Run `queries` (those not already running) in the background; the run id, or None when
    every one was already running. Queries started within COALESCE_S of each other (same project,
    target and env) share one run. `kind` is what Cancel and the progress show it as."""
    fresh = [q for q in queries if q.key not in _running]
    if not fresh:
        return None
    key = (project_id, ctx, kind)
    group = _open.get(key)
    if group is None:
        group = _Group(uuid.uuid4().hex[:12], project_path, [])
        _open[key] = group
        task = asyncio.create_task(_run_after_window(key, group))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
    group.queries.extend(fresh)
    for q in fresh:
        _running[q.key] = group.run_id
    return group.run_id


async def _run_after_window(key: tuple[int, QueryContext, str], group: _Group) -> None:
    await asyncio.sleep(COALESCE_S)
    if _open.get(key) is group:
        del _open[key]
    project_id, ctx, kind = key
    await _run(project_id, group.project_path, group.run_id, group.queries, ctx, kind)


async def wait_idle() -> None:
    """Until every background run has finished (tests)."""
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)


async def _run(project_id: int, project_path: Path, run_id: str, queries: list[PendingQuery], ctx: QueryContext,
               kind: str) -> None:
    by_hash: dict[str, list[PendingQuery]] = {}
    for q in queries:
        by_hash.setdefault(q.key.sql_hash, []).append(q)
    hashes = list(by_hash)
    started = time.monotonic()
    counts = {"errors": 0}
    from app.db.engine import SessionLocal  # tests swap it

    try:
        async with SessionLocal() as session:
            answered: set[int] = set()

            async def on_result(index: int, res: BatchResult) -> None:
                answered.add(index)
                group = by_hash[hashes[index]]
                elapsed_ms = int((time.monotonic() - started) * 1000)
                if not await _store(session, group, res, ctx, elapsed_ms):
                    counts["errors"] += 1
                for q in group:
                    _release(q.key, run_id)

            results = await run_many(project_id, project_path, [group[0].sql for group in by_hash.values()],
                                     target=ctx.target or None, lock_wait=LOCK_WAIT_S, kind=kind, run_id=run_id,
                                     on_result=on_result)
            for index, res in enumerate(results):  # any on_result didn't see (never the cancelled ones)
                if index not in answered and not res.cancelled:
                    await on_result(index, res)
    except Exception as exc:  # the page must hear the run ended, whatever happened
        log.exception("metric_queries_crashed", project_id=project_id, run_id=run_id)
        for q in queries:
            if _running.get(q.key) == run_id:
                _remember_failure(q.key, f"The run failed: {exc}")
        counts["errors"] = len(queries)
    finally:
        for q in queries:  # answered ones are already released; cancelled ones go back to not_run
            _release(q.key, run_id)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    log.info("metric_queries_ran", project_id=project_id, queries=len(by_hash), errors=counts["errors"],
             elapsed_ms=elapsed_ms, api_log=True)
    await bus.publish(Event(topic=f"project:{project_id}", type=FINISHED_EVENT, data={
        "run_id": run_id, "count": len(by_hash), "errors": counts["errors"], "elapsed_ms": elapsed_ms,
    }))


def _release(key: CacheKey, run_id: str) -> None:
    if _running.get(key) == run_id:
        del _running[key]


async def _store(session: AsyncSession, group: list[PendingQuery], res: BatchResult, ctx: QueryContext, elapsed_ms: int) -> bool:
    """Store one SQL's result for its queries (or remember the failure); False when it failed."""
    if res.error:
        for q in group:
            _remember_failure(q.key, res.error)
        return False
    for q in group:
        _failures.pop(q.key, None)
    q = group[0]
    try:
        await query_cache.store(
            session, q.key, columns=res.columns, rows=res.rows, truncated=res.truncated, ran_at=datetime.now(UTC),
            elapsed_ms=elapsed_ms, profile_name=ctx.profile_name, metrics=list(q.metrics), group_by=list(q.group_by),
        )
    except Exception:
        log.exception("metric_query_store_failed", project_id=q.key.project_id)
        for item in group:
            _remember_failure(item.key, "The result couldn't be stored.")
        return False
    return True
