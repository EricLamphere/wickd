import json
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.debug import running_debug
from app.db.engine import get_session
from app.db.models import AppSetting, DriftSnapshot, FreshnessSnapshot, ModelStatus, Project
from app.health.summary import summarize_connection, summarize_drift, summarize_freshness
from app.logging_setup import get_logger

router = APIRouter(prefix="/api/projects", tags=["health"])
log = get_logger(__name__)


class CheckSummaryDto(BaseModel):
    status: str  # not_run | running | ok | warn | fail
    headline: str
    issues: int
    finished_at: str | None
    target: str | None
    stale_reasons: list[str]


class HealthSummaryDto(BaseModel):
    connection: CheckSummaryDto
    drift: CheckSummaryDto
    freshness: CheckSummaryDto
    current_target: str | None


@router.get("/{project_id}/health/summary", response_model=HealthSummaryDto)
async def get_health_summary(
    project_id: int,
    session: AsyncSession = Depends(get_session),
) -> HealthSummaryDto:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")

    from app.api.init import load_project_env
    current_target = (await load_project_env(project_id)).get("DBT_TARGET")
    now = datetime.now(timezone.utc)

    drift = await _latest(session, DriftSnapshot, project_id)
    drift_input = _drift_input(drift)
    rebuilt = await _rebuilt_since(session, project_id, drift, drift_input)
    freshness = await _latest(session, FreshnessSnapshot, project_id)

    summaries = {
        "connection": summarize_connection(
            await _last_debug(session, project_id),
            running=project_id in running_debug, current_target=current_target, now=now,
        ),
        "drift": summarize_drift(drift_input, rebuilt_since=rebuilt, current_target=current_target),
        "freshness": summarize_freshness(
            _freshness_input(freshness), current_target=current_target, now=now
        ),
    }
    return HealthSummaryDto(
        **{k: CheckSummaryDto(**asdict(v)) for k, v in summaries.items()},
        current_target=current_target,
    )


async def _latest(session: AsyncSession, model, project_id: int):
    result = await session.execute(
        select(model).where(model.project_id == project_id).order_by(model.id.desc()).limit(1)
    )
    return result.scalar_one_or_none()


async def _last_debug(session: AsyncSession, project_id: int) -> dict[str, Any] | None:
    row = await session.get(AppSetting, f"health_check:{project_id}")
    return _load_json(row.value, None, "health_check") if row else None


def _drift_input(snap: DriftSnapshot | None) -> dict[str, Any] | None:
    if snap is None:
        return None
    return {
        "status": snap.status,
        "results": _load_json(snap.results_json, [], "drift_results"),
        "target": snap.target,
        "finished_at": snap.finished_at,
        "total": snap.total_models,
        "error_message": snap.error_message,
    }


def _freshness_input(snap: FreshnessSnapshot | None) -> dict[str, Any] | None:
    if snap is None:
        return None
    return {
        "status": snap.status,
        "results": _load_json(snap.results_json, [], "freshness_results"),
        "target": snap.target,
        "finished_at": snap.finished_at,
    }


async def _rebuilt_since(
    session: AsyncSession, project_id: int, snap: DriftSnapshot | None, drift_input: dict | None
) -> int:
    """Scanned models that ran successfully after the scan finished."""
    if snap is None or snap.finished_at is None or not drift_input:
        return 0
    uids = [r.get("unique_id") for r in drift_input["results"] if r.get("unique_id")]
    if not uids:
        return 0
    result = await session.execute(
        select(func.count()).select_from(ModelStatus).where(
            ModelStatus.project_id == project_id,
            ModelStatus.unique_id.in_(uids),
            ModelStatus.status == "success",
            ModelStatus.finished_at > snap.finished_at,
        )
    )
    return int(result.scalar_one())


def _load_json(raw: str, default: Any, what: str) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        log.warning("health_summary_bad_json", what=what)
        return default
