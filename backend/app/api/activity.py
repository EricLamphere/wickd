"""What a project is running right now, to seed the running-status bubble on mount (plan 29).

Events only describe what happens after a page subscribes, so after a reload or navigation the
bubble asks here once. Everything comes from in-memory state: the dbt runner's current command,
the init run in flight, project compiles and docs generation. Logs aren't replayed.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.init import active_run
from app.api.models import compile_started_at
from app.db.engine import get_session
from app.db.models import Project
from app.dbt.runner import runner
from app.projects import docs_state

router = APIRouter(prefix="/api/projects", tags=["activity"])


class RunActivityDto(BaseModel):
    command: str
    label: str
    select: str | None
    started_at: str
    invocation_id: int | None = None  # the Runs page row, when recorded
    command_line: str = ""  # the command as typed (no --profiles-dir), for copying


class InitActivityDto(BaseModel):
    steps: list[str]
    current_step: str | None
    started: int  # steps reached so far, including the one running
    started_at: str


class SimpleActivityDto(BaseModel):
    started_at: str | None  # None when the start time isn't tracked (docs)


class ActivitySnapshotDto(BaseModel):
    run: RunActivityDto | None
    init: InitActivityDto | None
    compile: SimpleActivityDto | None
    docs: SimpleActivityDto | None


def _run(project_id: int) -> RunActivityDto | None:
    current = runner.current(project_id)
    if current is None:
        return None
    return RunActivityDto(
        command=current.command, label=current.label, select=current.select, started_at=current.started_at,
        invocation_id=current.invocation_id, command_line=current.command_line,
    )


def _init(project_id: int) -> InitActivityDto | None:
    run = active_run(project_id)
    if run is None:
        return None
    return InitActivityDto(
        steps=list(run.steps),
        current_step=run.current_step(),
        started=sum(1 for name in run.steps if name in run.started),
        started_at=run.started_at,
    )


def _compile(project_id: int) -> SimpleActivityDto | None:
    started_at = compile_started_at(project_id)
    return SimpleActivityDto(started_at=started_at) if started_at is not None else None


def _docs(project_id: int) -> SimpleActivityDto | None:
    # Only "generating" matches docs_generating; queued / initializing come before it (and an init
    # failure ends them without any project-topic docs event).
    run = docs_state.run_of(project_id)
    return SimpleActivityDto(started_at=None) if run is not None and run.state == "generating" else None


@router.get("/{project_id}/activity", response_model=ActivitySnapshotDto)
async def get_activity(project_id: int, session: AsyncSession = Depends(get_session)) -> ActivitySnapshotDto:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    return ActivitySnapshotDto(
        run=_run(project_id),
        init=_init(project_id),
        compile=_compile(project_id),
        docs=_docs(project_id),
    )
