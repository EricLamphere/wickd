"""Data diff routes (wickd Pro, plan 06): compare changed models built in dev with prod.

POST /data-diff starts one job for the given models (202, one snapshot per model); GET
/data-diff/latest lists the newest snapshot per model (optionally one model); GET /data-diff/{id}
one snapshot; POST /data-diff/cancel stops the running job and the dbt command it's waiting on.
The prod side is the DIFF_BASE_TARGET project setting; the dev side the active target.
"""

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.init import load_project_env
from app.data_diff.job import DiffRequest, Targets, run_job
from app.data_diff.staleness import NodeRebuild, load_rebuilds, rebuilt_after
from app.db.engine import get_session
from app.db.models import DataDiffSnapshot, Project
from app.dbt import data_diff
from app.dbt.runner import runner
from app.licensing.gating import require_pro
from app.semantic.compare import base_target_setting
from app.semantic.query_spec import QueryInvalid, check_sql_condition

router = APIRouter(prefix="/api/projects", tags=["data-diff"])

MAX_MODELS = 50
_running: dict[int, asyncio.Task] = {}


class StartDataDiffDto(BaseModel):
    unique_ids: list[str] = Field(min_length=1, max_length=MAX_MODELS)
    scope: Literal["working", "branch"] = "working"
    base: str | None = Field(default=None, max_length=255)
    keys: dict[str, list[str]] = Field(default_factory=dict)
    columns: dict[str, list[str]] = Field(default_factory=dict)
    where: dict[str, str] = Field(default_factory=dict)
    build: bool = True
    mode: Literal["auto", "separate"] = "auto"
    tolerance: float = Field(default=0.0, ge=0)


class DataDiffDto(BaseModel):
    id: int
    unique_id: str
    name: str
    scope: str
    base_ref: str | None
    dev_target: str | None
    prod_target: str | None
    dev_relation: str | None
    prod_relation: str | None
    mode: str | None
    key: list[str]
    key_source: str | None
    columns: list[str] | None
    where: str | None
    built: bool
    status: str  # running | done | error
    phase: str | None
    result: dict[str, Any] | None
    error_message: str | None
    started_at: str
    finished_at: str | None
    # the dev relation was rebuilt (run/build/clone/seed/snapshot) after this diff finished
    dev_rebuilt_at: str | None = None
    dev_rebuilt_by: str | None = None


def _loads(raw: str | None, default: Any) -> Any:
    try:
        value = json.loads(raw) if raw else default
    except ValueError:
        return default
    return value if isinstance(value, type(default)) or (default is None and isinstance(value, (dict, list))) else default


def _to_dto(s: DataDiffSnapshot, rebuild: NodeRebuild | None = None) -> DataDiffDto:
    return DataDiffDto(
        id=s.id, unique_id=s.unique_id, name=s.name, scope=s.scope, base_ref=s.base_ref, dev_target=s.dev_target,
        prod_target=s.prod_target, dev_relation=s.dev_relation, prod_relation=s.prod_relation, mode=s.mode,
        key=_loads(s.key_json, []), key_source=s.key_source, columns=_loads(s.columns_json, None), where=s.where_sql,
        built=bool(s.built), status=s.status, phase=s.phase, result=_loads(s.results_json, None),
        error_message=s.error_message, started_at=s.started_at.isoformat() if s.started_at else "",
        finished_at=s.finished_at.isoformat() if s.finished_at else None,
        dev_rebuilt_at=rebuild.completed_at.isoformat() if rebuild else None,
        dev_rebuilt_by=rebuild.command if rebuild else None,
    )


async def _to_dtos(session: AsyncSession, project_id: int, snaps: Sequence[DataDiffSnapshot]) -> list[DataDiffDto]:
    rebuilds = await load_rebuilds(session, project_id, sorted({s.unique_id for s in snaps}))
    return [_to_dto(s, rebuilt_after(s, rebuilds)) for s in snaps]


async def _gate(session: AsyncSession) -> None:
    await require_pro(session, available=data_diff.is_available, unavailable_detail=data_diff.UNAVAILABLE)


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _adapter_type(project: Project) -> str | None:
    try:
        data = json.loads((Path(project.path) / "target" / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return (data.get("metadata") or {}).get("adapter_type") if isinstance(data, dict) else None


def _check_filters(dto: StartDataDiffDto, adapter: str | None) -> None:
    for uid, where in dto.where.items():
        if not where.strip():
            continue
        try:
            check_sql_condition(where, adapter)
        except QueryInvalid as exc:
            raise HTTPException(status_code=400, detail={"error": "invalid_filter", "unique_id": uid,
                                                         "message": str(exc)}) from exc


async def _targets(session: AsyncSession, project: Project, env: dict[str, str]) -> Targets:
    from app.api.runs import _profiles_default_target

    prod = await base_target_setting(session, project.id)
    dev = env.get("DBT_TARGET") or _profiles_default_target(project)
    if not prod:
        raise HTTPException(status_code=400, detail={
            "error": "no_base_target",
            "message": "Set DIFF_BASE_TARGET (Environment → Project settings) to the target to compare with, e.g. prod."})
    if not dev:
        raise HTTPException(status_code=400, detail={"error": "no_target", "message": "No active dbt target is set."})
    if dev == prod:
        raise HTTPException(status_code=400, detail={
            "error": "same_target", "message": f"The active target is `{dev}`, the same as DIFF_BASE_TARGET. Switch to your dev target."})
    return Targets(dev=dev, prod=prod)


@router.post("/{project_id}/data-diff", status_code=202, response_model=list[DataDiffDto])
async def start_data_diff(project_id: int, dto: StartDataDiffDto, session: AsyncSession = Depends(get_session)) -> list[DataDiffDto]:
    await _gate(session)
    project = await _project(session, project_id)
    existing = _running.get(project_id)
    if existing is not None and not existing.done():
        raise HTTPException(status_code=409, detail="a data diff is already running for this project")
    _check_filters(dto, _adapter_type(project))
    env = await load_project_env(project_id)
    targets = await _targets(session, project, env)
    uids = list(dict.fromkeys(dto.unique_ids))
    snaps = [
        DataDiffSnapshot(
            project_id=project_id, unique_id=uid, name=uid.split(".")[-1], scope=dto.scope,
            base_ref=dto.base if dto.scope == "branch" else None, dev_target=targets.dev, prod_target=targets.prod,
            columns_json=json.dumps(dto.columns[uid]) if dto.columns.get(uid) else None,
            where_sql=(dto.where.get(uid) or "").strip() or None, built=dto.build, status="running", phase="queued",
        )
        for uid in uids
    ]
    session.add_all(snaps)
    await session.commit()
    for s in snaps:
        await session.refresh(s)
    req = DiffRequest(unique_ids=uids, scope=dto.scope, base=dto.base, keys=dto.keys, columns=dto.columns,
                      where=dto.where, build=dto.build, mode=dto.mode, tolerance=dto.tolerance)
    detached = Project(id=project.id, name=project.name, path=project.path, profile=project.profile)
    _running[project_id] = asyncio.create_task(run_job(detached, req, targets, env, {s.unique_id: s.id for s in snaps}))
    return [_to_dto(s) for s in snaps]


@router.get("/{project_id}/data-diff/latest", response_model=list[DataDiffDto])
async def latest_data_diffs(
    project_id: int, unique_id: str | None = Query(None), session: AsyncSession = Depends(get_session),
) -> list[DataDiffDto]:
    await _gate(session)
    await _project(session, project_id)
    newest = (select(func.max(DataDiffSnapshot.id)).where(DataDiffSnapshot.project_id == project_id)
              .group_by(DataDiffSnapshot.unique_id))
    if unique_id:
        newest = newest.where(DataDiffSnapshot.unique_id == unique_id)
    rows = (await session.execute(
        select(DataDiffSnapshot).where(DataDiffSnapshot.id.in_(newest)).order_by(DataDiffSnapshot.id)
    )).scalars().all()
    return await _to_dtos(session, project_id, rows)


@router.post("/{project_id}/data-diff/cancel")
async def cancel_data_diff(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    await _gate(session)
    await _project(session, project_id)
    task = _running.get(project_id)
    if task is None or task.done():
        return {"cancelled": False}
    runner.cancel(project_id)
    task.cancel()
    return {"cancelled": True}


@router.get("/{project_id}/data-diff/{snapshot_id}", response_model=DataDiffDto)
async def get_data_diff(project_id: int, snapshot_id: int, session: AsyncSession = Depends(get_session)) -> DataDiffDto:
    await _gate(session)
    snap = await session.get(DataDiffSnapshot, snapshot_id)
    if snap is None or snap.project_id != project_id:
        raise HTTPException(status_code=404, detail="data diff not found")
    return (await _to_dtos(session, project_id, [snap]))[0]
