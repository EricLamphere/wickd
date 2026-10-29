"""A dashboard's widget results: cached on open, refreshed together in one `dbt show`.

Every widget is planned (dashboard_plan.py) into a few role-tagged queries, and each
query is explained first (MetricFlow, ~5 ms), so a YAML edit is a cache miss by
construction, exactly like the explorer (query_service.py). `cached_results()` never
touches the warehouse, so a dashboard opens instantly; `refresh()` runs the queries in
one batch (batch.run_many; identical SQL once) and stores each in metric_query_results,
so the explorer and the dashboard share results.
"""

import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Project
from app.logging_setup import get_logger
from app.semantic import query_cache, service
from app.semantic.batch import run_many
from app.semantic.dashboard_plan import WidgetBroken, WidgetPlan, plan_widget
from app.semantic.dashboards import Dashboard
from app.semantic.query_cache import CacheKey
from app.semantic.query_service import QueryContext, explain_checked, query_context
from app.semantic.query_spec import QueryInvalid

log = get_logger(__name__)


@dataclass(frozen=True)
class QueryResult:
    status: str  # ok | not_run | error
    query: dict[str, Any]
    sql: str | None = None
    columns: list[str] = field(default_factory=list)
    rows: list[list] = field(default_factory=list)
    truncated: bool = False
    ran_at: datetime | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status, "query": self.query, "sql": self.sql, "columns": self.columns, "rows": self.rows,
            "truncated": self.truncated, "ran_at": self.ran_at.isoformat() if self.ran_at else None, "error": self.error,
        }


@dataclass(frozen=True)
class WidgetResult:
    widget_id: str
    status: str  # ok | not_run | error | empty (no metric yet)
    error: str | None = None
    notes: tuple[str, ...] = ()
    grain: str | None = None
    current: dict[str, str] | None = None
    previous: dict[str, str] | None = None
    queries: dict[str, QueryResult] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        ran = sorted(q.ran_at for q in self.queries.values() if q.ran_at)
        return {
            "widget_id": self.widget_id, "status": self.status, "error": self.error, "notes": list(self.notes),
            "grain": self.grain, "current": self.current, "previous": self.previous,
            "ran_at": ran[0].isoformat() if ran else None,
            "queries": {role: q.to_dict() for role, q in self.queries.items()},
        }


@dataclass(frozen=True)
class _Explained:
    widget_id: str
    role: str
    query: dict[str, Any]
    sql: str
    key: CacheKey
    metrics: tuple[str, ...]


def _message(exc: Exception) -> str:
    return getattr(exc, "message", None) or str(exc)


def _widget(plan: WidgetPlan, queries: dict[str, QueryResult]) -> WidgetResult:
    statuses = {q.status for q in queries.values()}
    error = next((q.error for q in queries.values() if q.status == "error"), None)
    status = "empty" if plan.empty else "error" if error else "not_run" if "not_run" in statuses else "ok"
    return WidgetResult(
        plan.widget_id, status, error=error, notes=plan.notes, grain=plan.grain,
        current=plan.current.to_dict() if plan.current else None,
        previous=plan.previous.to_dict() if plan.previous else None, queries=queries,
    )


async def _explain_all(
    project: Project, dashboard: Dashboard, adapter_type: str | None, ctx: QueryContext,
    widget_ids: Iterable[str] | None, today: date,
) -> tuple[list[WidgetPlan], list[_Explained], dict[tuple[str, str], QueryResult], dict[str, WidgetResult]]:
    """(plans, queries ready to look up or run, queries that failed to explain, broken widgets)."""
    wanted = set(widget_ids) if widget_ids is not None else None
    catalog = await service.catalog(Path(project.path))
    plans: list[WidgetPlan] = []
    ready: list[_Explained] = []
    failed: dict[tuple[str, str], QueryResult] = {}
    broken: dict[str, WidgetResult] = {}
    for widget in dashboard.widgets:
        if wanted is not None and widget.id not in wanted:
            continue
        try:
            plan = plan_widget(widget, dashboard, catalog, today)
        except WidgetBroken as exc:
            broken[widget.id] = WidgetResult(widget.id, "error", error=str(exc))
            continue
        plans.append(plan)
        for q in plan.queries:
            try:
                sql = (await explain_checked(project, q.query, adapter_type))["sql"]
            except (service.SemanticError, QueryInvalid) as exc:
                failed[(widget.id, q.role)] = QueryResult("error", q.query, error=_message(exc))
                continue
            key = CacheKey(project.id, ctx.target, ctx.env_fingerprint, query_cache.sql_hash(sql))
            ready.append(_Explained(widget.id, q.role, q.query, sql, key, tuple(widget.metrics)))
    return plans, ready, failed, broken


def _assemble(dashboard: Dashboard, plans: list[WidgetPlan], by_query: dict[tuple[str, str], QueryResult],
              broken: dict[str, WidgetResult]) -> list[WidgetResult]:
    results = dict(broken)
    for plan in plans:
        results[plan.widget_id] = _widget(plan, {q.role: by_query[(plan.widget_id, q.role)] for q in plan.queries})
    return [results[w.id] for w in dashboard.widgets if w.id in results]


def _cached(e: _Explained, hit: query_cache.CachedResult | None) -> QueryResult:
    if hit is None:
        return QueryResult("not_run", e.query, sql=e.sql)
    return QueryResult("ok", e.query, sql=e.sql, columns=hit.columns, rows=hit.rows, truncated=hit.truncated,
                       ran_at=hit.ran_at)


async def cached_results(
    session: AsyncSession, project: Project, dashboard: Dashboard, adapter_type: str | None, *, today: date | None = None,
) -> tuple[QueryContext, list[WidgetResult]]:
    """Each widget's stored results for the current target + env (`not_run` where there's none)."""
    ctx = await query_context(session, project.id, Path(project.path))
    plans, ready, by_query, broken = await _explain_all(project, dashboard, adapter_type, ctx, None, today or date.today())
    for e in ready:
        by_query[(e.widget_id, e.role)] = _cached(e, await query_cache.lookup(session, e.key))
    return ctx, _assemble(dashboard, plans, by_query, broken)


async def refresh(
    session: AsyncSession, project: Project, dashboard: Dashboard, adapter_type: str | None,
    widget_ids: Iterable[str] | None = None, *, today: date | None = None,
) -> tuple[QueryContext, list[WidgetResult]]:
    """Run `widget_ids` (None = every widget) on the warehouse in one batch; store and return the results.

    Raises runtime.RuntimeUnavailable when the MetricFlow sidecar can't start (the whole refresh fails)."""
    ctx = await query_context(session, project.id, Path(project.path))
    plans, ready, by_query, broken = await _explain_all(
        project, dashboard, adapter_type, ctx, widget_ids, today or date.today())
    unique: dict[str, str] = {}
    for e in ready:
        unique.setdefault(e.key.sql_hash, e.sql)
    started = time.monotonic()
    batch = await run_many(project.id, Path(project.path), list(unique.values()), target=ctx.target or None) if unique else []
    elapsed_ms = int((time.monotonic() - started) * 1000)
    ran_at = datetime.now(UTC)
    by_hash = dict(zip(unique.keys(), batch, strict=True))
    stored: set[str] = set()
    for e in ready:
        res = by_hash[e.key.sql_hash]
        if res.error:
            by_query[(e.widget_id, e.role)] = QueryResult("error", e.query, sql=e.sql, error=res.error)
            continue
        if e.key.sql_hash not in stored:
            stored.add(e.key.sql_hash)
            await _store(session, e, res.columns, res.rows, res.truncated, ran_at, elapsed_ms, ctx)
        by_query[(e.widget_id, e.role)] = QueryResult("ok", e.query, sql=e.sql, columns=res.columns, rows=res.rows,
                                                      truncated=res.truncated, ran_at=ran_at)
    results = _assemble(dashboard, plans, by_query, broken)
    log.info("dashboard_refreshed", project_id=project.id, widgets=len(results), queries=len(unique),
             errors=sum(1 for r in results if r.status == "error"), elapsed_ms=elapsed_ms)
    return ctx, results


async def _store(
    session: AsyncSession, e: _Explained, columns: list[str], rows: list[list], truncated: bool,
    ran_at: datetime, elapsed_ms: int, ctx: QueryContext,
) -> None:
    try:
        await query_cache.store(
            session, e.key, columns=columns, rows=rows, truncated=truncated, ran_at=ran_at, elapsed_ms=elapsed_ms,
            profile_name=ctx.profile_name, metrics=list(e.metrics), group_by=list(e.query.get("group_by") or []),
        )
    except Exception:  # a failed cache write shouldn't lose the widget's result
        log.exception("dashboard_cache_store_failed", project_id=e.key.project_id, widget=e.widget_id)

