"""Metric debugging routes (plan 15): the Debug panel under the explorer's results.

Base: POST …/semantic/debug (plan + checks), …/debug/cancel, …/debug/reconcile.
Pro:  POST …/semantic/debug/explain ("Why is this number this?").
"""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.semantic import ExplainDto, _http_error, _project, _require_available, _semantic_http
from app.db.engine import get_session
from app.licensing.gating import require_pro
from app.logging_setup import get_logger
from app.semantic import debug, debug_pro, service
from app.semantic.debug_reconcile import ReconcileError, reconcile
from app.semantic.execute import ExecutionError
from app.semantic.query_service import run_metric_query
from app.semantic.query_spec import QueryInvalid
from app.semantic.runtime import RuntimeUnavailable

router = APIRouter(prefix="/api/projects", tags=["semantic-debug"])
log = get_logger(__name__)

_ERRORS = (service.SemanticError, RuntimeUnavailable, ExecutionError, QueryInvalid)


class DebugDto(BaseModel):
    query: ExplainDto
    # false: stored check results only; true: run the missing ones in one batch
    run: bool = True
    # rerun every check, stored or not
    refresh: bool = False


class ReconcileDto(BaseModel):
    query: ExplainDto
    sql: Annotated[str, StringConstraints(min_length=1, max_length=20_000)]


class ExplainNumberDto(BaseModel):
    query: ExplainDto


def _cancelled() -> Exception:
    return _http_error(409, "cancelled", "The checks were cancelled.")


@router.post("/{project_id}/semantic/debug")
async def post_debug(project_id: int, dto: DebugDto, session: AsyncSession = Depends(get_session)) -> dict:
    """The query's plan (MetricFlow's steps and joins) and its checks: input rows, filter, nulls and
    time coverage per input; fan-out and unmatched rows per join; nulls and spellings per group-by."""
    project = await _project(session, project_id)
    status = await _require_available(session, project, query=True)
    try:
        return await debug.run_debug(session, project, dto.query.model_dump(exclude_none=True), status.adapter_type,
                                     run=dto.run, refresh=dto.refresh)
    except debug.DebugCancelled as exc:
        raise _cancelled() from exc
    except _ERRORS as exc:
        raise _semantic_http(exc) from exc


@router.post("/{project_id}/semantic/debug/cancel")
async def post_debug_cancel(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    await _project(session, project_id)
    return {"cancelled": debug.cancel(project_id)}


@router.post("/{project_id}/semantic/debug/reconcile")
async def post_reconcile(project_id: int, dto: ReconcileDto, session: AsyncSession = Depends(get_session)) -> dict:
    """The metric next to a plain SQL query that should equal it, aligned by the group-by columns:
    {columns, rows (differences only), summary, compared, truncated, sql_truncated}."""
    project = await _project(session, project_id)
    status = await _require_available(session, project, query=True)
    query = dto.query.model_dump(exclude_none=True)
    try:
        ours, theirs, keys = await debug.run_reconcile_inputs(session, project, query, dto.sql, status.adapter_type)
        out = reconcile(ours, theirs, keys, list(query.get("metrics") or []))
    except debug.DebugCancelled as exc:
        raise _cancelled() from exc
    except ReconcileError as exc:
        raise _http_error(400, "reconcile_columns", str(exc)) from exc
    except _ERRORS as exc:
        raise _semantic_http(exc) from exc
    return {**out, "sql_truncated": bool(theirs.get("truncated"))}


@router.post("/{project_id}/semantic/debug/explain")
async def post_explain_number(project_id: int, dto: ExplainNumberDto, session: AsyncSession = Depends(get_session)) -> dict:
    """Pro: a written explanation of the result from its stored checks and the definitions."""
    await require_pro(session, available=debug_pro.is_available)
    project = await _project(session, project_id)
    status = await _require_available(session, project, query=True)
    query = dto.query.model_dump(exclude_none=True)
    try:
        report = await debug.run_debug(session, project, query, status.adapter_type, run=False)
        catalog = await service.catalog(Path(project.path))
        result = await run_metric_query(session, project, query, status.adapter_type, cache="only")
    except _ERRORS as exc:
        raise _semantic_http(exc) from exc
    if any(c["status"] == "not_run" for c in report["checks"]):
        raise _http_error(409, "checks_not_run", "Run the checks first: the explanation is built from them.")
    metrics = list(query.get("metrics") or [])
    by_name = {m["name"]: m for m in catalog.get("metrics", [])}
    definitions = {
        m: {**{k: by_name.get(m, {}).get(k) for k in ("type", "label", "description")},
            "inputs": [i for i in report["inputs"] if i.get("via") == m]}
        for m in metrics
    }
    context = {
        "metrics": metrics, "query": query, "definitions": definitions, "plan": report["plan"],
        "checks": report["checks"], "notes": report["notes"], "group_by": report["group_by"],
        "result": {"columns": result.columns, "rows": result.rows[:500]} if result is not None else None,
    }
    try:
        return debug_pro.explain(context)
    except debug_pro.MetricDebugUnavailable as exc:
        raise _http_error(503, "pro_unavailable", str(exc)) from exc
