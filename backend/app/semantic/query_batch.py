"""Many metric queries at once (plan 13: the metric index's sparklines, a metric page's chart).

Each query is explained (the SQL is the cache key, as in query_service.py) and its stored
result returned. With `run`, the queries without one run together in one background `dbt show`
(query_runs.py; identical SQL once) and are stored, so the explorer, dashboards and these share
results. Every item carries its SQL (View SQL works for a query that hasn't run or failed). A
query that can't be explained or fails gets its error; the others still answer.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Project
from app.logging_setup import get_logger
from app.semantic import data_freshness, query_cache, query_runs, service
from app.semantic.query_cache import CacheKey
from app.semantic.query_service import MetricQueryOutcome, explain_checked, query_context
from app.semantic.query_spec import QueryInvalid

log = get_logger(__name__)


@dataclass(frozen=True)
class BatchItem:
    # stale: a stored result from before the data last changed (data_freshness.py), still shown
    status: Literal["ok", "stale", "not_run", "running", "error"]
    result: MetricQueryOutcome | None = None
    error: str | None = None
    # the explained SQL, also when not run or failed (the SQL dialog shows it for debugging)
    sql: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status, "result": self.result.to_dict() if self.result else None,
            "error": self.error, "sql": self.sql if self.sql is not None else (self.result.sql if self.result else None),
        }


@dataclass(frozen=True)
class _Explained:
    index: int
    query: Mapping[str, Any]
    sql: str
    key: CacheKey


def _message(exc: Exception) -> str:
    return getattr(exc, "message", None) or str(exc)


def _from_cache(e: _Explained, hit: query_cache.CachedResult) -> MetricQueryOutcome:
    return MetricQueryOutcome(
        sql=e.sql, sql_hash=e.key.sql_hash, columns=hit.columns, rows=hit.rows, truncated=hit.truncated,
        ran_at=hit.ran_at, elapsed_ms=hit.elapsed_ms, target=hit.target, profile_name=hit.profile_name, source="cache",
    )


async def run_queries(
    session: AsyncSession, project: Project, queries: Sequence[Mapping[str, Any]], adapter_type: str | None,
    *, run: bool = False, refresh: bool = False,
) -> list[BatchItem]:
    """One item per query, in order: stored results (`stale` when older than the project's last
    run / build / seed on the target), `running` while a background run has it, a recent failure
    as `error`; with `run`, the rest (stale and failed included) start in one background run and
    answer `running` — metric_queries_finished says when to read them again. `refresh` reruns
    every query, stored or not.

    Raises runtime.RuntimeUnavailable when the MetricFlow sidecar can't start."""
    ctx = await query_context(session, project.id, Path(project.path))
    changed_at = await data_freshness.data_changed_at(session, project.id, Path(project.path), ctx.target)
    items: list[BatchItem] = [BatchItem("not_run")] * len(queries)
    to_run: list[query_runs.PendingQuery] = []
    for i, query in enumerate(queries):
        try:
            sql = (await explain_checked(project, query, adapter_type))["sql"]
        except (service.SemanticError, QueryInvalid) as exc:
            items[i] = BatchItem("error", error=_message(exc))
            continue
        e = _Explained(i, query, sql, CacheKey(project.id, ctx.target, ctx.env_fingerprint, query_cache.sql_hash(sql)))
        pending = query_runs.PendingQuery(
            e.key, sql, tuple(query.get("metrics") or ()), tuple(query.get("group_by") or ()))
        state = query_runs.status(e.key)
        if state == query_runs.RUNNING:
            items[i] = BatchItem("running", sql=sql)
            continue
        hit = await query_cache.lookup(session, e.key)
        stale = hit is not None and data_freshness.is_stale(hit.ran_at, changed_at)
        if hit is not None and not refresh and not (stale and run):
            items[i] = BatchItem("stale" if stale else "ok", _from_cache(e, hit))
        elif run or refresh:
            to_run.append(pending)
            items[i] = BatchItem("running", sql=sql)
        elif isinstance(state, query_runs.Failure):
            items[i] = BatchItem("error", error=state.error, sql=sql)
        else:
            items[i] = BatchItem("not_run", sql=sql)
    if to_run:
        query_runs.start(project.id, Path(project.path), to_run, ctx)
    return items
