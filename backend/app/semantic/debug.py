"""Metric debugging (plan 15, Base): the Debug panel's data for one metric query.

    explain_plan (worker) → SQL steps + plan → check queries (debug_queries.py)
    → stored results, the missing ones run in ONE run_many() batch → findings (debug_checks.py)

Nothing runs until the panel asks. Check results are stored in metric_query_results like any
metric result (keyed by their SQL), so reopening Debug costs no queries; `refresh` reruns them.
One debug run per project at a time can be cancelled (cancel()): the dbt process is killed.
"""

import asyncio
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Project
from app.logging_setup import get_logger
from app.semantic import query_cache, service
from app.semantic.batch import BatchResult, run_many
from app.semantic.debug_checks import interpret, warnings
from app.semantic.debug_queries import CheckQuery, build_checks, resolve_filter
from app.semantic.debug_sql import attach_steps, sql_steps
from app.semantic.execute import run_sql
from app.semantic.query_cache import CacheKey
from app.semantic.query_service import QueryContext, query_context, run_metric_query
from app.semantic.query_spec import QueryInvalid, check_query, checked_sql

log = get_logger(__name__)

DEBUG_GROUP_BY_MARK = "wickd:debug"
_running: dict[int, asyncio.Task] = {}


class DebugCancelled(Exception):
    """The user cancelled the checks."""


@dataclass(frozen=True)
class _Prepared:
    check: CheckQuery
    sql: str | None  # None: it didn't pass the read-only check
    key: CacheKey | None
    error: str | None = None


def _require_metrics(query: Mapping[str, Any]) -> list[str]:
    if query.get("saved_query"):
        raise QueryInvalid("Debug works on metrics: open the saved query's metrics in the query view")
    metrics = list(query.get("metrics") or [])
    if not metrics:
        raise QueryInvalid("pick at least one metric to debug")
    return metrics


async def explain_for_debug(project: Project, query: Mapping[str, Any], adapter_type: str | None) -> dict:
    """The worker's explain_plan, validated, with SQL steps attached to the plan."""
    _require_metrics(query)
    path = Path(project.path)
    check_query(query, await service.catalog(path), adapter_type)
    explained = await service.explain_plan(path, dict(query))
    sql = checked_sql(explained["sql"], adapter_type)
    steps = sql_steps(sql)
    return {**explained, "sql": sql, "steps": steps, "plan": attach_steps(explained.get("plan") or [], steps)}


def _prepare(checks: list[CheckQuery], adapter_type: str | None, project_id: int, ctx: QueryContext) -> list[_Prepared]:
    out = []
    for cq in checks:
        try:
            sql = checked_sql(cq.sql, adapter_type)
        except QueryInvalid as exc:
            out.append(_Prepared(cq, None, None, str(exc)))
            continue
        out.append(_Prepared(cq, sql, CacheKey(project_id, ctx.target, ctx.env_fingerprint, query_cache.sql_hash(sql))))
    return out


async def _results(
    session: AsyncSession, project: Project, prepared: list[_Prepared], ctx: QueryContext, metrics: list[str],
    refresh: bool,
) -> tuple[dict[str, BatchResult], int, datetime | None]:
    """{sql_hash: result} for every runnable check, how many ran now, and the newest run time."""
    by_hash: dict[str, BatchResult] = {}
    newest: datetime | None = None
    missing: dict[str, str] = {}
    for p in prepared:
        if p.key is None or p.key.sql_hash in by_hash or p.key.sql_hash in missing:
            continue
        hit = None if refresh else await query_cache.lookup(session, p.key)
        if hit is None:
            missing[p.key.sql_hash] = p.sql or ""
            continue
        by_hash[p.key.sql_hash] = BatchResult(hit.columns, hit.rows, hit.truncated)
        newest = max(newest or hit.ran_at, hit.ran_at)
    if not missing:
        return by_hash, 0, newest
    started = time.monotonic()
    batch = await run_many(project.id, Path(project.path), list(missing.values()), target=ctx.target or None)
    elapsed_ms, ran_at = int((time.monotonic() - started) * 1000), datetime.now(UTC)
    for sql_hash, res in zip(missing, batch, strict=True):
        by_hash[sql_hash] = res
        if res.error:
            continue
        try:
            await query_cache.store(
                session, CacheKey(project.id, ctx.target, ctx.env_fingerprint, sql_hash), columns=res.columns,
                rows=res.rows, truncated=res.truncated, ran_at=ran_at, elapsed_ms=elapsed_ms,
                profile_name=ctx.profile_name, metrics=metrics, group_by=[DEBUG_GROUP_BY_MARK],
            )
        except Exception:  # a failed cache write shouldn't lose the checks
            log.exception("metric_debug_cache_store_failed", project_id=project.id)
    return by_hash, len(missing), ran_at


async def _tracked(project_id: int, coro: Any) -> Any:
    """Run `coro` as this project's cancellable debug task."""
    previous = _running.get(project_id)
    if previous is not None and not previous.done():
        previous.cancel()
    task = asyncio.ensure_future(coro)
    _running[project_id] = task
    try:
        return await task
    except asyncio.CancelledError as exc:
        if task.cancelled():
            raise DebugCancelled("The checks were cancelled.") from exc
        raise
    finally:
        if _running.get(project_id) is task:
            _running.pop(project_id, None)


def cancel(project_id: int) -> bool:
    task = _running.get(project_id)
    if task is None or task.done():
        return False
    task.cancel()
    return True


async def run_debug(
    session: AsyncSession, project: Project, query: Mapping[str, Any], adapter_type: str | None, *,
    run: bool = True, refresh: bool = False,
) -> dict[str, Any]:
    """{sql, plan, plan_error?, steps, checks, warnings, notes, queries, ran, ran_at, models, inputs (+ filter_sql),
    group_by, metric_defs}.

    `run` false: stored results only (checks without one are `not_run`)."""
    metrics = _require_metrics(query)
    explained = await explain_for_debug(project, query, adapter_type)
    checks, notes = build_checks(explained, query, adapter_type)
    if explained.get("inputs_error"):
        notes.append(f"Couldn't resolve the metric's inputs, so only the plan is shown: {explained['inputs_error']}")
    ctx = await query_context(session, project.id, Path(project.path))
    prepared = _prepare(checks, adapter_type, project.id, ctx)
    if run:
        by_hash, ran, ran_at = await _tracked(project.id, _results(session, project, prepared, ctx, metrics, refresh))
    else:
        by_hash, ran, ran_at = await _stored_only(session, prepared)
    findings: list[dict] = []
    for p in prepared:
        if p.key is None:
            findings += interpret(p.check, None, p.error)
        elif (res := by_hash.get(p.key.sql_hash)) is None:
            findings.append({"id": f"{p.check.id}:pending", "kind": p.check.kind, "check": "pending",
                             "node": p.check.node, "status": "not_run", "title": "Not run yet", "value": "—",
                             "detail": "", "sql": p.sql, "data": dict(p.check.meta)})
        else:
            findings += interpret(p.check, res.rows, res.error)
    log.info("metric_debug", project_id=project.id, metrics=metrics, checks=len(prepared), ran=ran)
    return {
        "sql": explained["sql"], "columns": explained.get("columns") or [], "plan": explained["plan"],
        "plan_error": explained.get("plan_error"), "steps": explained["steps"], "checks": findings,
        "warnings": warnings(findings), "notes": notes, "queries": len({p.key.sql_hash for p in prepared if p.key}),
        "ran": ran, "ran_at": ran_at.isoformat() if ran_at else None, "models": explained.get("models") or {},
        "inputs": _with_filter_sql(explained), "group_by": explained.get("group_by") or [],
        "metric_defs": explained.get("metric_defs") or {},
    }


def _with_filter_sql(explained: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Inputs plus `filter_sql`: their filters as SQL on their own table (None when one needs a join).
    Reconcile's draft uses it."""
    models = explained.get("models") or {}
    out = []
    for item in explained.get("inputs") or []:
        model = models.get(item.get("semantic_model")) or {}
        parts = [resolve_filter(f, model) for f in item.get("filters") or []]
        sql = None if any(p is None for p in parts) else " and ".join(f"({p})" for p in parts if p)
        out.append({**item, "filter_sql": sql})
    return out


async def _stored_only(session: AsyncSession, prepared: list[_Prepared]) -> tuple[dict[str, BatchResult], int, datetime | None]:
    by_hash: dict[str, BatchResult] = {}
    newest: datetime | None = None
    for p in prepared:
        if p.key is None or p.key.sql_hash in by_hash:
            continue
        hit = await query_cache.lookup(session, p.key)
        if hit is not None:
            by_hash[p.key.sql_hash] = BatchResult(hit.columns, hit.rows, hit.truncated)
            newest = max(newest or hit.ran_at, hit.ran_at)
    return by_hash, 0, newest


async def run_reconcile_inputs(
    session: AsyncSession, project: Project, query: Mapping[str, Any], sql: str, adapter_type: str | None,
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    """(metric result, SQL result, key columns) for Reconcile with SQL: the metric from the cache
    when stored, the user's SQL (checked by ai/sql_guard: one SELECT, literal ref/source only) fresh."""
    from app.ai.sql_guard import QueryRejected, dialect_for, validate_select

    _require_metrics(query)
    try:
        cleaned = validate_select(sql, dialect_for(adapter_type))
    except QueryRejected as exc:
        raise QueryInvalid(str(exc)) from exc

    async def both() -> tuple[Any, Any]:
        outcome = await run_metric_query(session, project, query, adapter_type, cache="prefer")
        result = await run_sql(project.id, Path(project.path), cleaned, adapter_type, limit=5000)
        return outcome, result

    outcome, result = await _tracked(project.id, both())
    assert outcome is not None  # cache="prefer" always returns a result
    keys = [c for c in outcome.columns if c.lower() not in {m.lower() for m in query.get("metrics") or []}]
    return ({"columns": outcome.columns, "rows": outcome.rows},
            {"columns": result.columns, "rows": result.rows, "truncated": result.truncated}, keys)
