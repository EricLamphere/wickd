"""Semantic layer (MetricFlow) routes. Base feature: everything here wraps open-source MetricFlow.

Status, catalog, explain/query and the Health check under /semantic; the dbt-core
version change behind the compatibility dialog under /metricflow.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import Project, SemanticCheckSnapshot
from app.dbt.runner import RunRequest, runner
from app.logging_setup import get_logger
from app.semantic import check, dbt_change, service
from app.semantic.execute import DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, ExecutionError, run_sql
from app.semantic.runtime import RuntimeUnavailable
from app.semantic.spec import is_latest_spec_parse_error
from app.semantic.status import SemanticStatus, semantic_status

router = APIRouter(prefix="/api/projects", tags=["semantic"])
log = get_logger(__name__)

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
VERSION_PATTERN = r"^\d+\.\d+\.\d+([a-z0-9.+-]*)$"
PARSE_TIMEOUT_S = 300


class ExplainDto(BaseModel):
    metrics: list[Name] = Field(default_factory=list, max_length=50)
    group_by: list[Name] = Field(default_factory=list, max_length=50)
    where: list[Annotated[str, StringConstraints(max_length=4000)]] = Field(default_factory=list, max_length=20)
    order_by: list[Name] = Field(default_factory=list, max_length=20)
    limit: int | None = Field(default=None, ge=0, le=MAX_ROW_LIMIT)
    start: str | None = None
    end: str | None = None
    saved_query: Name | None = None


class QueryDto(ExplainDto):
    rows: int = Field(default=DEFAULT_ROW_LIMIT, ge=1, le=MAX_ROW_LIMIT)


class CheckDto(BaseModel):
    warehouse: bool = False


class PlanDbtChangeDto(BaseModel):
    version: Annotated[str, StringConstraints(strip_whitespace=True, pattern=VERSION_PATTERN)]
    want_cli: bool = False


class ApplyDbtChangeDto(PlanDbtChangeDto):
    update_pins: bool = True
    replace_ranges: bool = False


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _http_error(status_code: int, code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"error": code, "message": message, **extra})


async def _require_available(session: AsyncSession, project: Project, *, query: bool = False) -> SemanticStatus:
    """409 with the status's reason when MetricFlow can't run here (the UI opens the dialog)."""
    status = await semantic_status(session, project)
    if not status.available or (query and not status.can_query):
        raise _http_error(409, status.reason_code or "unavailable", status.reason or "MetricFlow isn't available",
                          status=status.to_dict())
    return status


def _semantic_http(exc: Exception) -> HTTPException:
    if isinstance(exc, RuntimeUnavailable):
        return _http_error(503, "runtime_unavailable", str(exc))
    if isinstance(exc, service.SemanticError):
        code = 400 if exc.code in ("invalid_query", "bad_request") else 409 if exc.code == "manifest_not_found" else 422
        return _http_error(code, exc.code, exc.message)
    if isinstance(exc, ExecutionError):
        return _http_error(504 if exc.code == "timeout" else 409 if exc.code == "busy" else 422, exc.code, exc.message)
    raise exc


# ── status, catalog, explain, query ──────────────────────────────────────────


@router.get("/{project_id}/semantic/status")
async def get_status(project_id: int, want_cli: bool = False, session: AsyncSession = Depends(get_session)) -> dict:
    return (await semantic_status(session, await _project(session, project_id), want_cli=want_cli)).to_dict()


@router.get("/{project_id}/semantic/catalog")
async def get_catalog(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    project = await _project(session, project_id)
    await _require_available(session, project)
    try:
        return await service.catalog(Path(project.path))
    except (service.SemanticError, RuntimeUnavailable) as exc:
        raise _semantic_http(exc) from exc


@router.post("/{project_id}/semantic/explain")
async def post_explain(project_id: int, dto: ExplainDto, session: AsyncSession = Depends(get_session)) -> dict:
    project = await _project(session, project_id)
    await _require_available(session, project, query=True)
    try:
        return await service.explain(Path(project.path), dto.model_dump(exclude_none=True))
    except (service.SemanticError, RuntimeUnavailable) as exc:
        raise _semantic_http(exc) from exc


@router.post("/{project_id}/semantic/query")
async def post_query(project_id: int, dto: QueryDto, session: AsyncSession = Depends(get_session)) -> dict:
    """Explain, then run the SQL with the user's dbt (`dbt show`). {sql, columns, rows, truncated}."""
    project = await _project(session, project_id)
    status = await _require_available(session, project, query=True)
    path = Path(project.path)
    try:
        explained = await service.explain(path, dto.model_dump(exclude_none=True, exclude={"rows"}))
        result = await run_sql(project_id, path, explained["sql"], status.adapter_type, limit=dto.rows)
    except (service.SemanticError, RuntimeUnavailable, ExecutionError) as exc:
        raise _semantic_http(exc) from exc
    return {"sql": explained["sql"], "columns": result.columns, "rows": result.rows, "truncated": result.truncated}


# ── Health check ──────────────────────────────────────────────────────────────


def _snapshot_dto(snap: SemanticCheckSnapshot | None) -> dict | None:
    if snap is None:
        return None
    try:
        results = json.loads(snap.results_json or "{}")
    except ValueError:
        results = {}
    return {
        "id": snap.id,
        "status": snap.status,
        "started_at": snap.started_at.isoformat() if snap.started_at else None,
        "finished_at": snap.finished_at.isoformat() if snap.finished_at else None,
        "results": results,
        "error_message": snap.error_message,
        "manifest_hash": snap.manifest_hash,
    }


async def latest_snapshot(session: AsyncSession, project_id: int) -> SemanticCheckSnapshot | None:
    result = await session.execute(
        select(SemanticCheckSnapshot)
        .where(SemanticCheckSnapshot.project_id == project_id)
        .order_by(SemanticCheckSnapshot.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


@router.get("/{project_id}/semantic/check/latest")
async def get_latest_check(project_id: int, session: AsyncSession = Depends(get_session)) -> dict | None:
    await _project(session, project_id)
    return _snapshot_dto(await latest_snapshot(session, project_id))


@router.post("/{project_id}/semantic/check")
async def post_check(project_id: int, dto: CheckDto, session: AsyncSession = Depends(get_session)) -> dict:
    project = await _project(session, project_id)
    status = await _require_available(session, project, query=dto.warehouse)
    if project_id in check.running:
        raise _http_error(409, "already_running", "A semantic layer check is already running.")
    info = await service.manifest_info(Path(project.path))
    snap = SemanticCheckSnapshot(project_id=project_id, status="running", manifest_hash=info.semantic_hash)
    session.add(snap)
    await session.commit()
    await session.refresh(snap)
    check.running.add(project_id)
    asyncio.create_task(check.run_check(project_id, Path(project.path), snap.id, warehouse=dto.warehouse))
    log.info("semantic_check_started", project_id=project_id, warehouse=dto.warehouse, adapter=status.adapter_type)
    return _snapshot_dto(snap) or {}


# ── dbt-core version change (compatibility dialog) ───────────────────────────


def _busy_reason() -> str | None:
    from app.api.settings import _python_env_busy_reason

    return _python_env_busy_reason()


def _change_http(exc: dbt_change.DbtChangeError) -> HTTPException:
    return _http_error(504 if exc.code == "timeout" else 409 if exc.code == "no_dbt_venv" else 422, exc.code, exc.message)


@router.post("/{project_id}/metricflow/plan-dbt-change")
async def plan_dbt_change(project_id: int, dto: PlanDbtChangeDto, session: AsyncSession = Depends(get_session)) -> dict:
    """What installing this dbt-core would change (pip dry run), and pins that would undo it."""
    project = await _project(session, project_id)
    try:
        return await dbt_change.plan(session, project_id, Path(project.path), dto.version, want_cli=dto.want_cli)
    except dbt_change.DbtChangeError as exc:
        raise _change_http(exc) from exc


@router.post("/{project_id}/metricflow/apply-dbt-change")
async def apply_dbt_change(project_id: int, dto: ApplyDbtChangeDto, session: AsyncSession = Depends(get_session)) -> dict:
    """Install dbt-core==version (+ adapters, + dbt-metricflow) via the global-setup stream."""
    from app.api.init import start_global_install

    project = await _project(session, project_id)
    busy = _busy_reason()
    if busy:
        raise _http_error(409, "busy", f"Can't change dbt-core while {busy} — try again once it finishes.")
    try:
        installed = await dbt_change.installed_packages()
    except dbt_change.DbtChangeError as exc:
        raise _change_http(exc) from exc
    pins = []
    if dto.update_pins:
        pins = await dbt_change.update_pins(
            session, project_id, Path(project.path), dto.version, replace_ranges=dto.replace_ranges
        )
    args = dbt_change.install_args(dto.version, dbt_change.adapter_packages(installed), want_cli=dto.want_cli)
    await start_global_install(args, session)
    service.forget_dbt_environment()
    log.info("metricflow_dbt_change_started", project_id=project_id, version=dto.version, install=args)
    return {"ok": True, "previous_version": installed.get("dbt-core"), "install": args, "pins_updated": pins}


@router.post("/{project_id}/metricflow/verify-dbt-change")
async def verify_dbt_change(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    """After an install: dbt --version, dbt parse, then the compatibility check again."""
    from app.api.init import load_project_env

    project = await _project(session, project_id)
    service.forget_dbt_environment()
    dbt_core, _ = await service.dbt_environment()
    parse_ok, parse_output = False, ""
    if dbt_core:
        env = await load_project_env(project_id)
        target = env.get("DBT_TARGET")
        req = RunRequest(project_id=project_id, project_path=Path(project.path), command="parse",
                         extra=("--target", target) if target else (), env=env)
        try:
            async with asyncio.timeout(PARSE_TIMEOUT_S):
                code, stdout, stderr = await runner.run(req)
            parse_ok = code == 0
            parse_output = (stdout.decode(errors="replace") + stderr.decode(errors="replace"))[-2000:]
        except TimeoutError:
            parse_output = f"dbt parse took longer than {PARSE_TIMEOUT_S}s"
    status = await semantic_status(session, project)
    return {
        "dbt_core": dbt_core,
        "parse_ok": parse_ok,
        "parse_output": parse_output,
        "latest_spec_parse_error": is_latest_spec_parse_error(parse_output),
        "status": status.to_dict(),
        "finished_at": datetime.now(UTC).isoformat(),
    }
