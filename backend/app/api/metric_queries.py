"""Metric queries in flight: what's running (with progress) and Cancel, wherever they were started
(metric index / pages, the query view, dashboards, debug checks, monitors, compare).

GET  …/semantic/queries/active  → {runs: [{run_id, kind, label, done, total, started_at, …}]}
POST …/semantic/queries/cancel  {run_ids?} → {cancelled}  (no run_ids = every metric run)
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.semantic import _project
from app.db.engine import get_session
from app.semantic import debug, query_control

router = APIRouter(prefix="/api/projects", tags=["metric-queries"])

RunId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class CancelDto(BaseModel):
    # none = every metric query run of the project
    run_ids: list[RunId] | None = Field(default=None, max_length=100)


@router.get("/{project_id}/semantic/queries/active")
async def get_active_queries(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    await _project(session, project_id)
    runs = [r for r in query_control.active(project_id) if r.kind in query_control.METRIC_KINDS]
    return {"runs": [r.to_dict() for r in runs]}


@router.post("/{project_id}/semantic/queries/cancel")
async def cancel_queries(project_id: int, dto: CancelDto, session: AsyncSession = Depends(get_session)) -> dict:
    """Stop the runs' dbt processes; finished results are kept, the rest go back to not run."""
    await _project(session, project_id)
    count = query_control.cancel(project_id, dto.run_ids)
    if dto.run_ids is None and debug.cancel(project_id):  # the Debug tab's checks run as their own task
        count += 1
    return {"cancelled": count}
