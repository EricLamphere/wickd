"""Per-node execution time across run history (side pane / Run History trend sparkline)."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import InvocationModelResult, Project, RunInvocation

router = APIRouter(prefix="/api/projects", tags=["runs"])


class NodeTrendPoint(BaseModel):
    invocation_id: int
    started_at: datetime | None
    execution_time: float | None
    status: str


@router.get("/{project_id}/node-trend/{unique_id:path}", response_model=list[NodeTrendPoint])
async def get_node_trend(
    project_id: int,
    unique_id: str,
    session: AsyncSession = Depends(get_session),
) -> list[NodeTrendPoint]:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    results_q = await session.execute(
        select(InvocationModelResult, RunInvocation.started_at)
        .join(RunInvocation, InvocationModelResult.invocation_id == RunInvocation.id)
        .where(
            InvocationModelResult.project_id == project_id,
            InvocationModelResult.unique_id == unique_id,
        )
        .order_by(RunInvocation.started_at.asc())
    )
    rows = results_q.fetchall()
    return [
        NodeTrendPoint(
            invocation_id=r.InvocationModelResult.invocation_id,
            started_at=r.started_at,
            execution_time=r.InvocationModelResult.execution_time,
            status=r.InvocationModelResult.status,
        )
        for r in rows
    ]
