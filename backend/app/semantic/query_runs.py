"""Metric queries run in the background (the metric page and index, the query view).

A slow warehouse used to hold one HTTP request open for the whole `dbt show` (minutes), which
the desktop webview could drop ("Load failed"). Now Run answers at once: the queries without a
stored result start here, their requests report `running`, and `metric_queries_finished` on the
project's stream tells the page to read them again — stored results, or the failure kept here.

Keyed by CacheKey (target + env + SQL), the same key as the result cache, so a query already
running isn't started twice, whoever asks. Failures are kept for FAILURE_TTL_S, so a refetch
shows the error instead of running the failing query again; Run / Refresh runs it anyway.
"""

import asyncio
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import query_cache
from app.semantic.batch import run_many
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


def start(project_id: int, project_path: Path, queries: list[PendingQuery], ctx: QueryContext) -> str | None:
    """Run `queries` (those not already running) in one background batch; the run id, or None
    when every one was already running."""
    fresh = [q for q in queries if q.key not in _running]
    if not fresh:
        return None
    run_id = uuid.uuid4().hex[:12]
    for q in fresh:
        _running[q.key] = run_id
    task = asyncio.create_task(_run(project_id, project_path, run_id, fresh, ctx))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return run_id


async def wait_idle() -> None:
    """Until every background run has finished (tests)."""
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)


async def _run(project_id: int, project_path: Path, run_id: str, queries: list[PendingQuery], ctx: QueryContext) -> None:
    unique: dict[str, str] = {}
    for q in queries:
        unique.setdefault(q.key.sql_hash, q.sql)
    started = time.monotonic()
    errors = 0
    try:
        results = await run_many(project_id, project_path, list(unique.values()), target=ctx.target or None,
                                 lock_wait=LOCK_WAIT_S)
        by_hash = dict(zip(unique.keys(), results, strict=True))
        errors = await _store(queries, by_hash, ctx, int((time.monotonic() - started) * 1000))
    except Exception as exc:  # the page must hear the run ended, whatever happened
        log.exception("metric_queries_crashed", project_id=project_id, run_id=run_id)
        for q in queries:
            _remember_failure(q.key, f"The run failed: {exc}")
        errors = len(queries)
    finally:
        for q in queries:
            if _running.get(q.key) == run_id:
                del _running[q.key]
    elapsed_ms = int((time.monotonic() - started) * 1000)
    log.info("metric_queries_ran", project_id=project_id, queries=len(unique), errors=errors,
             elapsed_ms=elapsed_ms, api_log=True)
    await bus.publish(Event(topic=f"project:{project_id}", type=FINISHED_EVENT, data={
        "run_id": run_id, "count": len(unique), "errors": errors, "elapsed_ms": elapsed_ms,
    }))


async def _store(queries: list[PendingQuery], by_hash: dict, ctx: QueryContext, elapsed_ms: int) -> int:
    """Store each result (once per SQL); remember each failure. The number of failed queries."""
    from app.db.engine import SessionLocal  # tests swap it

    ran_at = datetime.now(UTC)
    stored: set[str] = set()
    errors = 0
    async with SessionLocal() as session:
        for q in queries:
            res = by_hash[q.key.sql_hash]
            if res.error:
                _remember_failure(q.key, res.error)
                errors += 1
                continue
            _failures.pop(q.key, None)
            if q.key.sql_hash in stored:
                continue
            stored.add(q.key.sql_hash)
            try:
                await query_cache.store(
                    session, q.key, columns=res.columns, rows=res.rows, truncated=res.truncated, ran_at=ran_at,
                    elapsed_ms=elapsed_ms, profile_name=ctx.profile_name, metrics=list(q.metrics), group_by=list(q.group_by),
                )
            except Exception:
                log.exception("metric_query_store_failed", project_id=q.key.project_id)
                _remember_failure(q.key, "The result couldn't be stored.")
                errors += 1
    return errors
