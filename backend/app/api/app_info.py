"""App-level endpoints for the desktop updater (plan 32).

- GET  /api/app/info           wickd's version and whether this is the packaged desktop app
- GET  /api/app/busy           what an update-and-restart would interrupt right now
- POST /api/app/shutdown-prep  stop background work before the shell relaunches on a new version
"""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.init import active_run, global_setup_running
from app.config import _is_frozen
from app.db.engine import get_session
from app.db.models import Project, RunSchedule
from app.dbt.runner import runner
from app.logging_setup import get_logger
from app.runs import schedule_due as sd
from app.runs.scheduler import timing_for
from app.scheduling import loop as scheduler_loop
from app.version import app_version

log = get_logger(__name__)

router = APIRouter(prefix="/api/app", tags=["app"])

# A scheduled run due this soon counts as busy: restarting would make it fire late or be missed.
SCHEDULE_SOON = timedelta(minutes=5)


class AppInfoDto(BaseModel):
    version: str
    desktop: bool  # the packaged (PyInstaller) backend the desktop shell runs


class ActivityDto(BaseModel):
    project: str | None  # None for app-wide work (global setup)
    label: str


class BusyDto(BaseModel):
    busy: bool
    activities: list[ActivityDto]


@router.get("/info", response_model=AppInfoDto)
async def app_info() -> AppInfoDto:
    return AppInfoDto(version=app_version(), desktop=_is_frozen())


def _project_activities(project: Project) -> list[ActivityDto]:
    found: list[ActivityDto] = []
    current = runner.current(project.id)
    if current is not None:
        found.append(ActivityDto(project=project.name, label=f"dbt {current.label}"))
    elif runner.is_project_busy(project.id):
        found.append(ActivityDto(project=project.name, label="a dbt command"))
    if active_run(project.id) is not None:
        found.append(ActivityDto(project=project.name, label="the init pipeline"))
    return found


async def _due_soon(session: AsyncSession, now: datetime) -> list[ActivityDto]:
    """Scheduled runs that would come due within SCHEDULE_SOON."""
    rows = (await session.execute(
        select(RunSchedule, Project)
        .join(Project, Project.id == RunSchedule.project_id)
        .where(RunSchedule.enabled.is_(True))
    )).all()
    by_id = {schedule.id: (schedule, project) for schedule, project in rows}
    timings = [
        timing_for(schedule, paused=project.schedules_paused, ignored=project.ignored)
        for schedule, project in rows
    ]
    soon = [d for d in sd.due(timings, now + SCHEDULE_SOON) if d.scheduled_for > now - sd.GRACE]
    return [
        ActivityDto(project=by_id[d.id][1].name, label=f"scheduled run '{by_id[d.id][0].name}' (due in a few minutes)")
        for d in soon
    ]


@router.get("/busy", response_model=BusyDto)
async def app_busy(session: AsyncSession = Depends(get_session)) -> BusyDto:
    """What an update-and-restart would stop: dbt commands, init pipelines, global setup,
    and scheduled runs about to fire. The same in-flight state that gates a python_path change."""
    projects = (await session.execute(select(Project).order_by(Project.name))).scalars().all()
    activities = [a for p in projects for a in _project_activities(p)]
    if global_setup_running():
        activities.append(ActivityDto(project=None, label="global setup"))
    activities += await _due_soon(session, datetime.now(UTC))
    return BusyDto(busy=bool(activities), activities=activities)


@router.post("/shutdown-prep", status_code=204)
async def shutdown_prep() -> None:
    """Stop the scheduler ticker and the file watcher so nothing new starts while the shell
    swaps the app and relaunches. Idempotent; the shell kills the backend right after."""
    from app.watcher.service import watcher_manager  # lazy: the watcher imports half the app

    await scheduler_loop.stop()
    await watcher_manager.stop()
    log.info("shutdown_prep")
