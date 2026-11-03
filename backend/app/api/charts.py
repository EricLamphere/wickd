"""dbt Charts (Base; plan 17): a project's boards under `charts/`, static builds, `dct validate`,
live boards via `dct serve`, and exporting a wickd dashboard to board YAML.

Boards are discovered without dct (app/charts/discovery.py); everything else runs the pinned
`dct` from its sidecar venv, built on first use (`charts_env` progress on the global stream).
"""

import asyncio
import json
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import FileResponse
from pydantic import StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ai_dtos import AiProposalDto, proposal_dto
from app.api.ai_proposals import _publish
from app.api.dashboards import _context as dashboard_context
from app.api.dashboards import _read as read_dashboard
from app.api.semantic import _http_error, _project, _require_available, _semantic_http
from app.charts import build as builds
from app.charts import discovery, export_service, sidecar_env
from app.charts.env import ChartsUnavailable, DctContext, dct_context
from app.charts.runtime import HOST, LiveUnavailable, charts_servers
from app.charts.validate import ValidateFailed, validate
from app.db.engine import get_session
from app.db.models import AiProposal, AiProposalFile, Project
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import service
from app.semantic.runtime import RuntimeUnavailable

router = APIRouter(prefix="/api/projects", tags=["charts"])
log = get_logger(__name__)

EXPORT_KIND = "charts_board"
BoardId = Annotated[str, StringConstraints(min_length=1, max_length=300)]

_building: set[tuple[int, str]] = set()
_tasks: set[asyncio.Task] = set()


def _charts_http(exc: ChartsUnavailable | LiveUnavailable | ValidateFailed):
    if isinstance(exc, ChartsUnavailable):
        return _http_error(503 if exc.code == "sidecar_failed" else 409, exc.code, exc.message)
    if isinstance(exc, LiveUnavailable):
        return _http_error(502, "live_failed", str(exc))
    return _http_error(502, "validate_failed", str(exc))


def _board(project: Project, board_id: str) -> discovery.Board:
    board = discovery.find_board(Path(project.path), board_id)
    if board is None:
        raise _http_error(404, "board_not_found", f"There's no board `{board_id}` under charts/.")
    return board


async def _context(project: Project) -> DctContext:
    try:
        return await dct_context(project.id, Path(project.path))
    except ChartsUnavailable as exc:
        raise _charts_http(exc) from exc


def _board_out(project_id: int, board: discovery.Board) -> dict:
    return {**board.to_dict(), "build": builds.read_meta(project_id, board.id), "building": (project_id, board.id) in _building}


@router.get("/{project_id}/charts")
async def list_boards(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    """The project's boards (with their last build) and the sidecar / live server state; never runs dct."""
    project = await _project(session, project_id)
    path = Path(project.path)
    boards = await asyncio.to_thread(discovery.find_boards, path)
    sidecar = sidecar_env.status()
    return {
        "has_charts_dir": discovery.charts_dir(path).is_dir(),
        "boards": [_board_out(project_id, b) for b in boards],
        "version": sidecar_env.DCT_VERSION,
        "sidecar": sidecar.state,
        "live": charts_servers.status(project_id),
    }


async def _run_build(project_id: int, project: Project, board: discovery.Board) -> None:
    topic = f"project:{project_id}"
    try:
        try:
            ctx = await dct_context(project_id, Path(project.path))
            result = await builds.build_board(project_id, ctx, board)
            data = {"board": board.id, "ok": result.ok, "error": result.error}
        except ChartsUnavailable as exc:
            data = {"board": board.id, "ok": False, "error": exc.message}
        except Exception as exc:
            log.exception("dbt_charts_build_crashed", project_id=project_id, board=board.id)
            data = {"board": board.id, "ok": False, "error": f"the build failed: {exc}"}
    finally:
        _building.discard((project_id, board.id))
    await bus.publish(Event(topic=topic, type="charts_build_finished", data=data))


@router.post("/{project_id}/charts/build", status_code=202)
async def build_board(project_id: int, board: BoardId = Query(), session: AsyncSession = Depends(get_session)) -> dict:
    """Render the board to static HTML in the background (`charts_build_started` / `_finished`)."""
    project = await _project(session, project_id)
    found = _board(project, board)
    if found.error:
        raise _http_error(422, "board_invalid", found.error)
    key = (project_id, found.id)
    if key in _building:
        raise _http_error(409, "already_building", "This board is already building.")
    _building.add(key)
    await bus.publish(Event(topic=f"project:{project_id}", type="charts_build_started", data={"board": found.id}))
    task = asyncio.create_task(_run_build(project_id, project, found))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"board": found.id, "building": True}


@router.get("/{project_id}/charts/static")
async def board_static(project_id: int, board: BoardId = Query(), session: AsyncSession = Depends(get_session)) -> Response:
    """The board's last static build (one self-contained HTML file); 404 before the first build."""
    await _project(session, project_id)
    path = builds.static_file(project_id, board, builds.OUTPUT_FILE)
    if path is None:
        raise _http_error(404, "not_built", "This board hasn't been built yet.")
    return FileResponse(path, media_type="text/html", headers={"Cache-Control": "no-store"})


@router.post("/{project_id}/charts/validate")
async def validate_boards(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    """`dct validate` over charts/: schema + cross-reference issues per board (no warehouse)."""
    project = await _project(session, project_id)
    if not discovery.charts_dir(Path(project.path)).is_dir():
        return {"boards": {}}
    ctx = await _context(project)
    try:
        by_path = await validate(ctx)
    except ValidateFailed as exc:
        raise _charts_http(exc) from exc
    boards = discovery.find_boards(Path(project.path))
    by_id = {b.id: by_path[b.path] for b in boards if b.path in by_path}
    return {"boards": by_id}


@router.post("/{project_id}/charts/live")
async def start_live(project_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    """Start (or reuse) the project's `dct serve`; the base URL boards are embedded from."""
    project = await _project(session, project_id)
    ctx = await _context(project)
    try:
        port = await charts_servers.ensure(project_id, ctx)
    except LiveUnavailable as exc:
        raise _charts_http(exc) from exc
    return {"running": True, "port": port, "base_url": f"http://{HOST}:{port}"}


@router.post("/{project_id}/charts/live/touch")
async def touch_live(project_id: int) -> dict:
    """Keep the live server from its idle stop while a board is open."""
    return {"running": charts_servers.touch(project_id)}


@router.delete("/{project_id}/charts/live", status_code=204)
async def stop_live(project_id: int) -> Response:
    await charts_servers.stop(project_id)
    return Response(status_code=204)


# ── Export a wickd dashboard as a dbt Charts board ───────────────────────────


@router.post("/{project_id}/dashboards/{slug}/export/dct", response_model=AiProposalDto)
async def propose_dct_export(project_id: int, slug: str, session: AsyncSession = Depends(get_session)) -> AiProposalDto:
    """The dashboard as `charts/<slug>.yml`, as a proposal to review (kind `charts_board`): one query per
    widget from MetricFlow's SQL, relations as ref(); nothing runs and nothing is written until accepted."""
    project, setting = await dashboard_context(session, project_id)
    dashboard = read_dashboard(project, setting, slug)
    status = await _require_available(session, project)
    try:
        result = await export_service.export_dashboard(project, dashboard, status.adapter_type)
    except (service.SemanticError, RuntimeUnavailable) as exc:
        raise _semantic_http(exc) from exc
    if result.chart_count == 0:
        raise _http_error(422, "nothing_to_export", "None of this dashboard's widgets could be exported.",
                          notes=list(result.notes))
    relative = export_service.board_path(slug)
    target = Path(project.path) / relative
    original = target.read_text(encoding="utf-8") if target.is_file() else None
    summary = {"path": relative, "dashboard": slug, "charts": result.chart_count, "notes": list(result.notes),
               "dct_version": sidecar_env.DCT_VERSION}
    proposal = AiProposal(
        project_id=project_id, kind=EXPORT_KIND, unique_id=None,
        title=f"Export {dashboard.title} as a dbt Charts board", result_json=json.dumps({"summary": summary}),
        status="ready" if original != result.text else "empty",
        error_message=None if original != result.text else f"{relative} already matches this dashboard.",
    )
    session.add(proposal)
    await session.flush()
    if original != result.text:
        session.add(AiProposalFile(proposal_id=proposal.id, path=relative, op="create" if original is None else "modify",
                                   original_text=original, proposed_text=result.text))
    await session.commit()
    await session.refresh(proposal, attribute_names=["files"])
    await _publish(proposal)
    log.info("dbt_charts_export_proposed", project_id=project_id, slug=slug, path=relative, charts=result.chart_count)
    return proposal_dto(proposal)
