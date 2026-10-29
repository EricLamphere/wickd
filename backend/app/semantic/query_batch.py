"""Many metric queries at once (plan 13: the metric index's sparklines, a metric page's chart).

Each query is explained (the SQL is the cache key, as in query_service.py) and its stored
result returned. With `run`, the queries without one run together in one `dbt show`
(batch.run_many; identical SQL once) and are stored, so the explorer, dashboards and these
share results. A query that can't be explained or fails gets its error; the others still
answer.
"""

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Project
from app.logging_setup import get_logger
from app.semantic import query_cache, service
from app.semantic.batch import run_many
from app.semantic.query_cache import CacheKey
from app.semantic.query_service import (
    MetricQueryOutcome,
    QueryContext,
    explain_checked,
    query_context,
)
from app.semantic.query_spec import QueryInvalid

log = get_logger(__name__)


@dataclass(frozen=True)
class BatchItem:
    status: Literal["ok", "not_run", "error"]
    result: MetricQueryOutcome | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "result": self.result.to_dict() if self.result else None, "error": self.error}


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
    *, run: bool = False,
) -> list[BatchItem]:
    """One item per query, in order: stored results, and with `run` the missing ones run in one batch.

    Raises runtime.RuntimeUnavailable when the MetricFlow sidecar can't start."""
    ctx = await query_context(session, project.id, Path(project.path))
    items: list[BatchItem] = [BatchItem("not_run")] * len(queries)
    missing: list[_Explained] = []
    for i, query in enumerate(queries):
        try:
            sql = (await explain_checked(project, query, adapter_type))["sql"]
        except (service.SemanticError, QueryInvalid) as exc:
            items[i] = BatchItem("error", error=_message(exc))
            continue
        e = _Explained(i, query, sql, CacheKey(project.id, ctx.target, ctx.env_fingerprint, query_cache.sql_hash(sql)))
        hit = await query_cache.lookup(session, e.key)
        if hit is not None:
            items[i] = BatchItem("ok", _from_cache(e, hit))
        else:
            missing.append(e)
    if run and missing:
        for i, item in (await _run(session, project, missing, ctx)).items():
            items[i] = item
    return items


async def _run(session: AsyncSession, project: Project, missing: list[_Explained], ctx: QueryContext) -> dict[int, BatchItem]:
    unique: dict[str, str] = {}
    for e in missing:
        unique.setdefault(e.key.sql_hash, e.sql)
    started = time.monotonic()
    results = await run_many(project.id, Path(project.path), list(unique.values()), target=ctx.target or None)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    ran_at = datetime.now(UTC)
    by_hash = dict(zip(unique.keys(), results, strict=True))
    stored: set[str] = set()
    out: dict[int, BatchItem] = {}
    for e in missing:
        res = by_hash[e.key.sql_hash]
        if res.error:
            out[e.index] = BatchItem("error", error=res.error)
            continue
        if e.key.sql_hash not in stored:
            stored.add(e.key.sql_hash)
            try:
                await query_cache.store(
                    session, e.key, columns=res.columns, rows=res.rows, truncated=res.truncated, ran_at=ran_at,
                    elapsed_ms=elapsed_ms, profile_name=ctx.profile_name, metrics=list(e.query.get("metrics") or []),
                    group_by=list(e.query.get("group_by") or []),
                )
            except Exception:  # a failed cache write shouldn't lose the result
                log.exception("metric_batch_store_failed", project_id=project.id)
        out[e.index] = BatchItem("ok", MetricQueryOutcome(
            sql=e.sql, sql_hash=e.key.sql_hash, columns=res.columns, rows=res.rows, truncated=res.truncated,
            ran_at=ran_at, elapsed_ms=elapsed_ms, target=ctx.target, profile_name=ctx.profile_name, source="warehouse",
        ))
    log.info("metric_query_batch", project_id=project.id, queries=len(missing), unique=len(unique), elapsed_ms=elapsed_ms)
    return out
