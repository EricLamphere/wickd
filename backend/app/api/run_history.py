"""Run history reads: the Runs list, one run's detail and its log (`run_invocations`).

Launching runs (and rerun) lives in api/runs.py.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import InvocationModelResult, Project, RunInvocation, RunSchedule

router = APIRouter(prefix="/api/projects", tags=["runs"])


class RunInvocationDto(BaseModel):
    id: int
    command: str
    selector: str | None
    cli_command: str | None
    profile: str | None
    target: str | None
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    duration_seconds: float | None
    model_count: int
    success_count: int
    error_count: int
    # slim build settings the run used ({kind, ref, folder, sha, target, state, defer, favor_state})
    state: dict | None = None
    # the project's latest invocation, failed: `dbt retry` can pick up where it stopped
    retryable: bool = False
    # who started it (plan 27): manual | schedule | rerun, and the schedule it belongs to
    trigger: str = "manual"
    schedule_id: int | None = None
    schedule_name: str | None = None


class ModelTimingDto(BaseModel):
    unique_id: str
    name: str
    kind: str
    status: str
    execution_time: float | None
    message: str | None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    thread_id: str | None = None
    rows_affected: int | None = None
    bytes_processed: int | None = None


class RunInvocationDetailDto(RunInvocationDto):
    nodes: list[ModelTimingDto]
    threads: int | None = None
    elapsed_time: float | None = None
    # False for runs recorded before timing capture (or by dbt versions that don't write it)
    has_timing: bool = False


class RunHistoryPageDto(BaseModel):
    items: list[RunInvocationDto]
    total: int
    offset: int
    limit: int




def _as_utc(value: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; they were stored as UTC."""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def _state_record(inv: RunInvocation) -> dict | None:
    try:
        value = json.loads(inv.state_json) if inv.state_json else None
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _invocation_to_dto(
    inv: RunInvocation,
    model_count: int,
    success_count: int = 0,
    error_count: int = 0,
    latest_id: int | None = None,
    schedule_name: str | None = None,
) -> RunInvocationDto:
    duration: float | None = None
    if inv.started_at and inv.finished_at:
        duration = (inv.finished_at - inv.started_at).total_seconds()
    return RunInvocationDto(
        id=inv.id,
        command=inv.command,
        selector=inv.selector,
        cli_command=inv.cli_command,
        profile=inv.profile,
        target=inv.target,
        status=inv.status,
        started_at=inv.started_at,
        finished_at=inv.finished_at,
        duration_seconds=duration,
        model_count=model_count,
        success_count=success_count,
        error_count=error_count,
        state=_state_record(inv),
        retryable=inv.id == latest_id and inv.status == "error" and inv.command in RETRYABLE_COMMANDS,
        trigger=inv.trigger or "manual",
        schedule_id=inv.schedule_id,
        schedule_name=schedule_name,
    )


RETRYABLE_COMMANDS = frozenset({"run", "build", "test", "seed", "snapshot", "retry", "clone"})


async def latest_invocation_id(session: AsyncSession, project_id: int) -> int | None:
    result = await session.execute(
        select(RunInvocation.id).where(RunInvocation.project_id == project_id)
        .order_by(RunInvocation.id.desc()).limit(1)
    )
    return result.scalar_one_or_none()


async def _schedule_names(session: AsyncSession, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = await session.execute(select(RunSchedule.id, RunSchedule.name).where(RunSchedule.id.in_(ids)))
    return {sid: name for sid, name in rows.all()}


@router.get("/{project_id}/run-history", response_model=RunHistoryPageDto)
async def get_run_history(
    project_id: int,
    limit: int = Query(default=50, le=1000),
    offset: int = Query(default=0, ge=0),
    command: str | None = Query(default=None),
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    trigger: str | None = Query(default=None, pattern="^(manual|schedule|rerun)$"),
    session: AsyncSession = Depends(get_session),
) -> RunHistoryPageDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    base_q = select(RunInvocation).where(RunInvocation.project_id == project_id)
    if command:
        base_q = base_q.where(RunInvocation.command == command)
    if status:
        base_q = base_q.where(RunInvocation.status == status)
    if q:
        base_q = base_q.where(RunInvocation.selector.contains(q))
    if trigger:
        base_q = base_q.where(RunInvocation.trigger == trigger)

    count_result = await session.execute(
        select(func.count()).select_from(base_q.subquery())
    )
    total = count_result.scalar_one()

    invocations_result = await session.execute(
        base_q.order_by(RunInvocation.started_at.desc()).offset(offset).limit(limit)
    )
    invocations = invocations_result.scalars().all()
    if not invocations:
        return RunHistoryPageDto(items=[], total=total, offset=offset, limit=limit)

    inv_ids = [inv.id for inv in invocations]
    counts_result = await session.execute(
        select(
            InvocationModelResult.invocation_id,
            func.count(InvocationModelResult.id),
            func.sum(case((InvocationModelResult.status == "success", 1), else_=0)),
            func.sum(case((InvocationModelResult.status == "error", 1), else_=0)),
        )
        .where(InvocationModelResult.invocation_id.in_(inv_ids))
        .group_by(InvocationModelResult.invocation_id)
    )
    count_by_id: dict[int, tuple[int, int, int]] = {
        row[0]: (row[1], int(row[2] or 0), int(row[3] or 0))
        for row in counts_result.fetchall()
    }

    latest_id = await latest_invocation_id(session, project_id)
    names = await _schedule_names(session, {inv.schedule_id for inv in invocations if inv.schedule_id})
    items = [
        _invocation_to_dto(
            inv, *count_by_id.get(inv.id, (0, 0, 0)), latest_id=latest_id,
            schedule_name=names.get(inv.schedule_id) if inv.schedule_id else None,
        )
        for inv in invocations
    ]
    return RunHistoryPageDto(items=items, total=total, offset=offset, limit=limit)


@router.get("/{project_id}/run-history/{invocation_id}", response_model=RunInvocationDetailDto)
async def get_run_invocation_detail(
    project_id: int,
    invocation_id: int,
    session: AsyncSession = Depends(get_session),
) -> RunInvocationDetailDto:
    inv = await session.get(RunInvocation, invocation_id)
    if inv is None or inv.project_id != project_id:
        raise HTTPException(status_code=404, detail="invocation not found")

    results_q = await session.execute(
        select(InvocationModelResult)
        .where(InvocationModelResult.invocation_id == invocation_id)
        .order_by(
            InvocationModelResult.execution_time.desc().nulls_last(),
            InvocationModelResult.unique_id,
        )
    )
    results = results_q.scalars().all()

    nodes = [
        ModelTimingDto(
            unique_id=r.unique_id,
            name=r.name,
            kind=r.kind,
            status=r.status,
            execution_time=r.execution_time,
            message=r.message,
            started_at=_as_utc(r.started_at),
            completed_at=_as_utc(r.completed_at),
            thread_id=r.thread_id,
            rows_affected=r.rows_affected,
            bytes_processed=r.bytes_processed,
        )
        for r in results
    ]

    success_count = sum(1 for r in results if r.status == "success")
    error_count = sum(1 for r in results if r.status == "error")
    names = await _schedule_names(session, {inv.schedule_id} if inv.schedule_id else set())
    base = _invocation_to_dto(inv, len(nodes), success_count, error_count,
                              latest_id=await latest_invocation_id(session, project_id),
                              schedule_name=names.get(inv.schedule_id) if inv.schedule_id else None)
    return RunInvocationDetailDto(
        **base.model_dump(),
        nodes=nodes,
        threads=inv.threads,
        elapsed_time=inv.elapsed_time,
        has_timing=any(n.started_at is not None and n.completed_at is not None for n in nodes),
    )


@router.get("/{project_id}/run-history/{invocation_id}/log", response_model=None)
async def get_invocation_log(
    project_id: int,
    invocation_id: int,
    session: AsyncSession = Depends(get_session),
) -> dict:
    inv = await session.get(RunInvocation, invocation_id)
    if inv is None or inv.project_id != project_id:
        raise HTTPException(status_code=404, detail="invocation not found")
    if not inv.log_path:
        return {"lines": []}
    log_file = Path(inv.log_path)
    if not log_file.exists():
        return {"lines": []}
    try:
        text = log_file.read_text(encoding="utf-8", errors="replace")
        return {"lines": text.splitlines()}
    except OSError:
        return {"lines": []}
