"""What a project is running right now, to seed the running-status bubble on mount (plan 29).

Events only describe what happens after a page subscribes, so after a reload or navigation the
bubble asks here once. Everything comes from in-memory state: the dbt runner's current command,
the init run in flight, project compiles and docs generation. Logs aren't replayed for those.

It also returns the project's most recent finished dbt runs (`run_invocations`, with each run's
log tail), so the bubble's history survives a reload or an app restart.
"""

import shlex
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.init import active_run
from app.api.models import compile_started_at
from app.api.run_history import _as_utc
from app.db.engine import get_session
from app.db.models import InvocationModelResult, Project, RunInvocation
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


class RecentRunDto(BaseModel):
    """A finished dbt run from the Runs page, for the bubble's history."""
    invocation_id: int
    command: str
    label: str  # the command and its subcommand words (`source freshness`), as in run_started
    select: str | None
    command_line: str
    status: str  # success | warn | error (a cancelled run reads as error, as its run_finished did)
    started_at: datetime | None
    finished_at: datetime | None
    log: list[str]  # the last RECENT_LOG_LINES lines


class ActivitySnapshotDto(BaseModel):
    run: RunActivityDto | None
    init: InitActivityDto | None
    compile: SimpleActivityDto | None
    docs: SimpleActivityDto | None
    recent: list[RecentRunDto] = []  # newest first


RECENT_RUNS = 5
RECENT_LOG_LINES = 50
_LOG_TAIL_BYTES = 16_384
_FINISHED = ("success", "error", "cancelled")


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


def label_of(cli_command: str | None, command: str) -> str:
    """`dbt source freshness --select x` → `source freshness` (words up to the first flag)."""
    try:
        words = shlex.split(cli_command or "")
    except ValueError:
        words = (cli_command or "").split()
    if words[:1] == ["dbt"]:
        words = words[1:]
    label: list[str] = []
    for word in words:
        if word.startswith("-"):
            break
        label.append(word)
    return " ".join(label) or command


def log_tail(log_path: str | None, lines: int = RECENT_LOG_LINES) -> list[str]:
    """The last `lines` lines of a run's log, reading only the end of the file."""
    if not log_path:
        return []
    try:
        with Path(log_path).open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - _LOG_TAIL_BYTES))
            chunk = f.read()
    except OSError:
        return []
    text = chunk.decode("utf-8", errors="replace").splitlines()
    if size > _LOG_TAIL_BYTES and text:
        text = text[1:]  # the first line is probably cut
    return [line for line in text if line.strip()][-lines:]


async def _warned_ids(session: AsyncSession, ids: list[int]) -> set[int]:
    if not ids:
        return set()
    result = await session.execute(
        select(InvocationModelResult.invocation_id)
        .where(InvocationModelResult.invocation_id.in_(ids), InvocationModelResult.status == "warn")
        .distinct()
    )
    return set(result.scalars().all())


def _recent_status(status: str, warned: bool) -> str:
    if status == "success":
        return "warn" if warned else "success"
    return "error"


async def _recent(session: AsyncSession, project_id: int, running_id: int | None) -> list[RecentRunDto]:
    query = (
        select(RunInvocation)
        .where(RunInvocation.project_id == project_id, RunInvocation.status.in_(_FINISHED))
        .order_by(RunInvocation.id.desc())
        .limit(RECENT_RUNS)
    )
    if running_id is not None:
        query = query.where(RunInvocation.id != running_id)
    rows = list((await session.execute(query)).scalars().all())
    warned = await _warned_ids(session, [r.id for r in rows])
    return [
        RecentRunDto(
            invocation_id=r.id,
            command=r.command,
            label=label_of(r.cli_command, r.command),
            select=r.selector,
            command_line=r.cli_command or f"dbt {r.command}",
            status=_recent_status(r.status, r.id in warned),
            started_at=_as_utc(r.started_at),
            finished_at=_as_utc(r.finished_at),
            log=log_tail(r.log_path),
        )
        for r in rows
    ]


@router.get("/{project_id}/activity", response_model=ActivitySnapshotDto)
async def get_activity(project_id: int, session: AsyncSession = Depends(get_session)) -> ActivitySnapshotDto:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    run = _run(project_id)
    return ActivitySnapshotDto(
        run=run,
        init=_init(project_id),
        compile=_compile(project_id),
        docs=_docs(project_id),
        recent=await _recent(session, project_id, run.invocation_id if run else None),
    )
