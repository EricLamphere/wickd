"""Combined docs on the home page: which projects are included, and generating their docs.

The docs themselves stay per project (GET /projects/{id}/docs/data, cached per project by
the frontend); the home page joins them. Generation runs one project at a time, since each
one compiles against its warehouse: its init pipeline first, then its docs, both with the
profile picked on the home page (else the project's own) and the project's env vars.
"""

import asyncio
import json
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.docs import _docs_dir, _generate_docs
from app.api.init import load_project_env, run_init_for_docs
from app.db.engine import get_session
from app.db.models import AppSetting, GlobalProfile, Project
from app.logging_setup import get_logger
from app.projects import docs_state
from app.projects.service import wait_for_startup_scan

log = get_logger(__name__)

router = APIRouter(prefix="/api/workspace/docs", tags=["workspace-docs"])

SELECTION_KEY = "combined_docs_projects"
PROFILE_KEY = "combined_docs_profile_id"
MAX_PROJECTS = 1000

ProjectIds = Annotated[list[int], Field(max_length=MAX_PROJECTS)]

_generation_lock = asyncio.Lock()
_generation_tasks: set[asyncio.Task] = set()


class WorkspaceDocsProjectDto(BaseModel):
    id: int
    name: str
    platform: str
    generated_at: str | None
    state: str  # idle / queued / generating / done / error
    error: str | None


class WorkspaceDocsDto(BaseModel):
    selection: list[int]
    projects: list[WorkspaceDocsProjectDto]


class SelectionDto(BaseModel):
    project_ids: ProjectIds


class GenerateDto(BaseModel):
    project_ids: ProjectIds


class GenerateResultDto(BaseModel):
    queued: list[int]


class WorkspaceProfileDto(BaseModel):
    profile_id: int | None


async def _active_projects(session: AsyncSession) -> list[Project]:
    await wait_for_startup_scan()
    result = await session.execute(select(Project).where(Project.ignored.is_(False)).order_by(Project.name))
    return list(result.scalars().all())


async def saved_selection(session: AsyncSession) -> list[int]:
    """The saved project ids (may include projects ignored since). Unreadable reads as empty."""
    row = await session.get(AppSetting, SELECTION_KEY)
    if row is None:
        return []
    try:
        parsed = json.loads(row.value)
    except json.JSONDecodeError:
        log.warning("combined_docs_selection_unreadable")
        return []
    return [i for i in parsed if isinstance(i, int)] if isinstance(parsed, list) else []


async def saved_profile_id(session: AsyncSession) -> int | None:
    """The profile picked on the home page. One deleted since, or unreadable, reads as none."""
    row = await session.get(AppSetting, PROFILE_KEY)
    if row is None:
        return None
    try:
        profile_id = int(row.value)
    except ValueError:
        log.warning("combined_docs_profile_unreadable", value=row.value)
        return None
    return profile_id if await session.get(GlobalProfile, profile_id) is not None else None


async def scope_projects(session: AsyncSession) -> list[Project]:
    """What home page Wicky answers about: the saved selection, else every active project."""
    projects = await _active_projects(session)
    selection = await saved_selection(session)
    by_id = {p.id: p for p in projects}
    selected = [by_id[i] for i in selection if i in by_id]
    return selected or projects


def _generated_at(project_id: int) -> str | None:
    catalog = _docs_dir(project_id) / "catalog.json"
    try:
        mtime = catalog.stat().st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(mtime, tz=UTC).isoformat()


def _project_dto(project: Project) -> WorkspaceDocsProjectDto:
    run = docs_state.run_of(project.id)
    return WorkspaceDocsProjectDto(
        id=project.id,
        name=project.name,
        platform=project.platform,
        generated_at=_generated_at(project.id),
        state=run.state if run else "idle",
        error=run.error if run else None,
    )


async def _require_known(session: AsyncSession, project_ids: list[int]) -> dict[int, Project]:
    by_id = {p.id: p for p in await _active_projects(session)}
    unknown = [i for i in project_ids if i not in by_id]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown projects: {unknown}")
    return by_id


@router.get("", response_model=WorkspaceDocsDto)
async def get_workspace_docs(session: AsyncSession = Depends(get_session)) -> WorkspaceDocsDto:
    projects = await _active_projects(session)
    active = {p.id for p in projects}
    selection = [i for i in await saved_selection(session) if i in active]
    return WorkspaceDocsDto(selection=selection, projects=[_project_dto(p) for p in projects])


@router.put("/selection", response_model=SelectionDto)
async def put_selection(dto: SelectionDto, session: AsyncSession = Depends(get_session)) -> SelectionDto:
    await _require_known(session, dto.project_ids)
    project_ids = list(dict.fromkeys(dto.project_ids))
    value = json.dumps(project_ids)
    row = await session.get(AppSetting, SELECTION_KEY)
    if row is None:
        session.add(AppSetting(key=SELECTION_KEY, value=value))
    else:
        row.value = value
    await session.commit()
    return SelectionDto(project_ids=project_ids)


@router.get("/profile", response_model=WorkspaceProfileDto)
async def get_profile(session: AsyncSession = Depends(get_session)) -> WorkspaceProfileDto:
    return WorkspaceProfileDto(profile_id=await saved_profile_id(session))


@router.put("/profile", response_model=WorkspaceProfileDto)
async def put_profile(
    dto: WorkspaceProfileDto, session: AsyncSession = Depends(get_session)
) -> WorkspaceProfileDto:
    if dto.profile_id is not None and await session.get(GlobalProfile, dto.profile_id) is None:
        raise HTTPException(status_code=404, detail="global profile not found")
    row = await session.get(AppSetting, PROFILE_KEY)
    if dto.profile_id is None:
        if row is not None:
            await session.delete(row)
    elif row is None:
        session.add(AppSetting(key=PROFILE_KEY, value=str(dto.profile_id)))
    else:
        row.value = str(dto.profile_id)
    await session.commit()
    return dto


async def _init_then_generate(project_id: int, path: str, profile_id: int | None) -> None:
    await docs_state.mark(project_id, "initializing")
    failure = await run_init_for_docs(project_id, profile_id=profile_id)
    if failure is not None:
        tail = docs_state.failure_summary(list(failure.log_lines))
        await docs_state.mark(project_id, "error", f"Init step '{failure.step}' failed:\n{tail}")
        return
    # Loaded after the pipeline, so vars its scripts just captured are included
    env = await load_project_env(project_id, profile_id=profile_id)
    await _generate_docs(project_id, path, env=env)


async def _generate_in_turn(targets: list[tuple[int, str]], profile_id: int | None) -> None:
    async with _generation_lock:
        for project_id, path in targets:
            try:
                await _init_then_generate(project_id, path, profile_id)
            except Exception as exc:  # noqa: BLE001 — one project's failure must not stop the rest
                log.warning("combined_docs_generate_failed", project_id=project_id, error=str(exc))
                await docs_state.mark(project_id, "error", str(exc))


@router.post("/generate", response_model=GenerateResultDto, status_code=status.HTTP_202_ACCEPTED)
async def generate(dto: GenerateDto, session: AsyncSession = Depends(get_session)) -> GenerateResultDto:
    by_id = await _require_known(session, dto.project_ids)
    wanted = [i for i in dict.fromkeys(dto.project_ids) if not docs_state.is_active(i)]
    profile_id = await saved_profile_id(session)
    for project_id in wanted:
        await docs_state.mark(project_id, "queued")
    if wanted:
        task = asyncio.create_task(_generate_in_turn([(i, by_id[i].path) for i in wanted], profile_id))
        _generation_tasks.add(task)
        task.add_done_callback(_generation_tasks.discard)
    return GenerateResultDto(queued=wanted)


async def wait_for_generation() -> None:
    """Let queued generation finish (tests and shutdown)."""
    if _generation_tasks:
        await asyncio.gather(*_generation_tasks, return_exceptions=True)
