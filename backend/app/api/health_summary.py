import asyncio
import json
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.debug import running_debug
from app.db.engine import get_session
from app.db.models import (
    AppSetting,
    DriftSnapshot,
    FreshnessSnapshot,
    ModelStatus,
    Project,
    SemanticCheckSnapshot,
)
from app.health.summary import (
    CheckSummary,
    summarize_connection,
    summarize_drift,
    summarize_freshness,
    summarize_semantic,
)
from app.logging_setup import get_logger
from app.semantic.service import has_semantic_nodes, manifest_info
from app.semantic.status import INCOMPATIBLE_REASONS, project_spec, semantic_status

router = APIRouter(prefix="/api/projects", tags=["health"])
log = get_logger(__name__)


class CheckSummaryDto(BaseModel):
    status: str  # not_run | running | ok | warn | fail
    headline: str
    issues: int
    finished_at: str | None
    target: str | None
    stale_reasons: list[str]
    runnable: bool = True


class HealthSummaryDto(BaseModel):
    connection: CheckSummaryDto
    drift: CheckSummaryDto
    freshness: CheckSummaryDto
    # null when the project has no semantic layer (the tab is hidden)
    semantic: CheckSummaryDto | None = None
    current_target: str | None


@router.get("/{project_id}/health/summary", response_model=HealthSummaryDto)
async def get_health_summary(
    project_id: int,
    session: AsyncSession = Depends(get_session),
) -> HealthSummaryDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    from app.api.init import load_project_env
    current_target = (await load_project_env(project_id)).get("DBT_TARGET")
    now = datetime.now(UTC)

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
    semantic = await _semantic_summary(session, project)
    return HealthSummaryDto(
        **{k: CheckSummaryDto(**asdict(v)) for k, v in summaries.items()},
        semantic=CheckSummaryDto(**asdict(semantic)) if semantic else None,
        current_target=current_target,
    )


async def _semantic_summary(session: AsyncSession, project: Project) -> CheckSummary | None:
    """MetricFlow validations; None for projects without a semantic layer.

    A project whose YAML defines one but whose manifest doesn't (dbt < 1.12 can't parse
    the latest spec) still gets the check, showing why MetricFlow can't run.
    """
    path = Path(project.path)
    info = await manifest_info(path)
    if not has_semantic_nodes(info):
        spec = await asyncio.to_thread(project_spec, path, info.manifest_mtime)
        if spec == "none":
            return None
    status = await semantic_status(session, project)
    snap = await _latest(session, SemanticCheckSnapshot, project.id)
    snap_input = None if snap is None else {
        "status": snap.status,
        "results": _load_json(snap.results_json, {}, "semantic_results"),
        "finished_at": snap.finished_at,
        "manifest_hash": snap.manifest_hash,
    }
    return summarize_semantic(
        snap_input,
        metricflow_off=status.mode == "off",
        manifest_hash=info.semantic_hash,
        blocked_reason=status.reason if status.reason_code in INCOMPATIBLE_REASONS else None,
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
