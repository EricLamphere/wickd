"""Metric dashboards (Base; plan 11): files under DASHBOARDS_PATH, cached results, batch refresh,
Register as exposure.

The file format and store are app/semantic/dashboards.py; widget queries (the dashboard's
period and filters merged in) are dashboard_plan.py; results are dashboard_refresh.py.
"""

from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, StringConstraints, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.semantic import _http_error, _project, _require_available, _semantic_http
from app.db.engine import get_session
from app.db.models import Project, ProjectEnvVar
from app.dbt.schema_exposures import ExposureSpec
from app.dbt.schema_yaml import SchemaYamlError
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import dashboard_exposure, dashboard_refresh, service
from app.semantic import dashboards as store
from app.semantic.dashboards import Dashboard, DashboardEntry, DashboardError
from app.semantic.execute import ExecutionError
from app.semantic.query_service import QueryContext
from app.semantic.query_spec import QueryInvalid
from app.semantic.runtime import RuntimeUnavailable

router = APIRouter(prefix="/api/projects", tags=["dashboards"])
log = get_logger(__name__)

_refreshing: set[tuple[int, str]] = set()
_ERROR_STATUS = {"not_found": 404, "exists": 409, "conflict": 409}


class CreateDto(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    widgets: list[dict[str, Any]] = Field(default_factory=list, max_length=store.MAX_WIDGETS)


class SaveDto(BaseModel):
    dashboard: dict[str, Any]
    # the file's modified_at when the editor loaded it; a newer file on disk is a 409
    base_modified_at: str | None = None


class RefreshDto(BaseModel):
    widget_ids: list[Annotated[str, StringConstraints(max_length=80)]] | None = Field(default=None, max_length=store.MAX_WIDGETS)


class ExposureDto(BaseModel):
    owner: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    name: Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[a-z_][a-z0-9_]*$", max_length=200)] | None = None


def _dashboard_http(exc: DashboardError) -> HTTPException:
    return _http_error(_ERROR_STATUS.get(exc.code, 400), exc.code, exc.message)


async def _setting(session: AsyncSession, project_id: int) -> str | None:
    return (await session.execute(
        select(ProjectEnvVar.value).where(ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == store.SETTING_KEY)
    )).scalar_one_or_none()


def _modified(entry: DashboardEntry) -> str | None:
    return datetime.fromtimestamp(entry.mtime, UTC).isoformat() if entry.mtime else None


def _summary(entry: DashboardEntry) -> dict:
    d = entry.dashboard
    return {
        "slug": entry.slug, "path": entry.path, "title": d.title if d else entry.slug,
        "widget_count": len(d.widgets) if d else 0, "exposure": d.exposure if d else None,
        "error": entry.error, "modified_at": _modified(entry),
    }


def _detail(entry: DashboardEntry) -> dict:
    return {**_summary(entry), "dashboard": store.to_data(entry.dashboard) if entry.dashboard else None}


def _validated(data: dict[str, Any]) -> Dashboard:
    try:
        return Dashboard.model_validate(data)
    except ValidationError as exc:
        raise _http_error(400, "invalid_dashboard", store.validation_message(exc)) from exc


async def _changed(project_id: int, slug: str) -> None:
    await bus.publish(Event(topic=f"project:{project_id}", type="dashboards_changed", data={"slug": slug}))


async def _context(session: AsyncSession, project_id: int) -> tuple[Project, str | None]:
    return await _project(session, project_id), await _setting(session, project_id)


def _read(project: Project, setting: str | None, slug: str) -> Dashboard:
    try:
        entry = store.read(Path(project.path), setting, slug)
    except DashboardError as exc:
        raise _dashboard_http(exc) from exc
    if entry.dashboard is None:
        raise _http_error(422, "invalid_dashboard", f"{entry.path}: {entry.error}")
    return entry.dashboard


# ── files ────────────────────────────────────────────────────────────────────


@router.get("/{project_id}/dashboards")
async def list_dashboards(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    project, setting = await _context(session, project_id)
    try:
        folder = store.dashboards_dir(Path(project.path), setting)
        entries = store.list_dashboards(Path(project.path), setting)
    except DashboardError as exc:
        raise _dashboard_http(exc) from exc
    return {
        "folder": folder.relative_to(Path(project.path).resolve()).as_posix(),
        "dashboards": [_summary(e) for e in entries],
    }


@router.post("/{project_id}/dashboards", status_code=201)
async def create_dashboard(project_id: int, dto: CreateDto, session: AsyncSession = Depends(get_session)) -> dict:
    project, setting = await _context(session, project_id)
    dashboard = _validated({"version": 1, "title": dto.title, "widgets": dto.widgets})
    try:
        slug = store.unique_slug(Path(project.path), setting, dto.title)
        entry = store.write(Path(project.path), setting, slug, dashboard, create=True)
    except DashboardError as exc:
        raise _dashboard_http(exc) from exc
    log.info("dashboard_created", project_id=project_id, slug=slug)
    await _changed(project_id, slug)
    return _detail(entry)


@router.get("/{project_id}/dashboards/{slug}")
async def get_dashboard(project_id: int, slug: str, session: AsyncSession = Depends(get_session)) -> dict:
    project, setting = await _context(session, project_id)
    try:
        return _detail(store.read(Path(project.path), setting, slug))
    except DashboardError as exc:
        raise _dashboard_http(exc) from exc


@router.put("/{project_id}/dashboards/{slug}")
async def save_dashboard(project_id: int, slug: str, dto: SaveDto, session: AsyncSession = Depends(get_session)) -> dict:
    project, setting = await _context(session, project_id)
    dashboard = _validated(dto.dashboard)
    try:
        current = store.read(Path(project.path), setting, slug)
        if dto.base_modified_at and _modified(current) and _modified(current) != dto.base_modified_at:
            raise DashboardError("conflict", f"{current.path} changed on disk since you opened it — reload to see the new version")
        entry = store.write(Path(project.path), setting, slug, dashboard)
    except DashboardError as exc:
        raise _dashboard_http(exc) from exc
    await _changed(project_id, slug)
    return _detail(entry)


@router.delete("/{project_id}/dashboards/{slug}", status_code=204)
async def delete_dashboard(project_id: int, slug: str, session: AsyncSession = Depends(get_session)) -> Response:
    project, setting = await _context(session, project_id)
    try:
        store.delete(Path(project.path), setting, slug)
    except DashboardError as exc:
        raise _dashboard_http(exc) from exc
    log.info("dashboard_deleted", project_id=project_id, slug=slug)
    await _changed(project_id, slug)
    return Response(status_code=204)


# ── results ──────────────────────────────────────────────────────────────────


def _results(ctx: QueryContext, widgets: list[dashboard_refresh.WidgetResult]) -> dict:
    return {"target": ctx.target or None, "profile_name": ctx.profile_name, "widgets": [w.to_dict() for w in widgets]}


@router.get("/{project_id}/dashboards/{slug}/results")
async def get_results(project_id: int, slug: str, session: AsyncSession = Depends(get_session)) -> dict:
    """Each widget's stored results for the current target (never runs anything)."""
    project, setting = await _context(session, project_id)
    dashboard = _read(project, setting, slug)
    status = await _require_available(session, project, query=True)
    try:
        ctx, widgets = await dashboard_refresh.cached_results(session, project, dashboard, status.adapter_type)
    except (service.SemanticError, RuntimeUnavailable, QueryInvalid) as exc:
        raise _semantic_http(exc) from exc
    return _results(ctx, widgets)


@router.post("/{project_id}/dashboards/{slug}/refresh")
async def refresh_dashboard(
    project_id: int, slug: str, dto: RefreshDto, session: AsyncSession = Depends(get_session)
) -> dict:
    """Run the widgets (all, or `widget_ids`) on the warehouse in one batch; per-widget results or errors."""
    project, setting = await _context(session, project_id)
    dashboard = _read(project, setting, slug)
    status = await _require_available(session, project, query=True)
    key = (project_id, slug)
    if key in _refreshing:
        raise _http_error(409, "already_running", "This dashboard is already refreshing.")
    _refreshing.add(key)
    try:
        ctx, widgets = await dashboard_refresh.refresh(session, project, dashboard, status.adapter_type, dto.widget_ids)
    except (service.SemanticError, RuntimeUnavailable, QueryInvalid, ExecutionError) as exc:
        raise _semantic_http(exc) from exc
    finally:
        _refreshing.discard(key)
    return _results(ctx, widgets)


# ── Register as exposure ─────────────────────────────────────────────────────


@router.post("/{project_id}/dashboards/{slug}/exposure")
async def register_exposure(
    project_id: int, slug: str, dto: ExposureDto, session: AsyncSession = Depends(get_session)
) -> dict:
    """Write a `type: dashboard` exposure depending on the widgets' metrics; {path, name}."""
    project, setting = await _context(session, project_id)
    path = Path(project.path)
    dashboard = _read(project, setting, slug)
    dashboard_path = store.file_for(path, setting, slug).relative_to(path.resolve()).as_posix()
    await _require_available(session, project)
    try:
        metrics = dashboard_exposure.dashboard_metrics(dashboard, await service.catalog(path))
    except (service.SemanticError, RuntimeUnavailable) as exc:
        raise _semantic_http(exc) from exc
    name = dto.name or dashboard_exposure.exposure_name(slug)
    spec = ExposureSpec(name=name, owner=dto.owner, metrics=metrics, description=dashboard.title,
                        dashboard_path=dashboard_path)
    try:
        written = dashboard_exposure.register(path, spec)
        store.write(path, setting, slug, dashboard.model_copy(update={"exposure": name}))
    except SchemaYamlError as exc:
        raise _http_error(422, "yaml_edit_failed", str(exc)) from exc
    except DashboardError as exc:
        raise _dashboard_http(exc) from exc
    log.info("dashboard_exposure_registered", project_id=project_id, slug=slug, exposure=name, path=written)
    await _changed(project_id, slug)
    return {"path": written, "name": name}
