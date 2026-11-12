"""
The home page bottom pane's logs (no project).

GET    /api/workspace/logs/project  — last N lines of workspace_logs.log (combined docs runs)
DELETE /api/workspace/logs/project  — truncate it
GET    /api/workspace/logs/api      — last N lines of api_logs.log (every request)
DELETE /api/workspace/logs/api      — truncate it
"""

from fastapi import APIRouter, Query

from app.api.logs import LogLinesDto, OkDto, _clear_log_file
from app.logs.api_logger import get_api_log_path, read_api_log_tail
from app.logs.workspace_logger import clear_workspace_log, read_workspace_log_tail

router = APIRouter(prefix="/api/workspace/logs", tags=["logs"])

MAX_TAIL = 2000


@router.get("/project", response_model=LogLinesDto)
async def get_workspace_project_logs(tail: int = Query(500, ge=1)) -> LogLinesDto:
    return LogLinesDto(lines=read_workspace_log_tail(lines=min(tail, MAX_TAIL)))


@router.delete("/project", response_model=OkDto)
async def clear_workspace_project_logs() -> OkDto:
    clear_workspace_log()
    return OkDto(ok=True)


@router.get("/api", response_model=LogLinesDto)
async def get_workspace_api_logs(tail: int = Query(500, ge=1)) -> LogLinesDto:
    return LogLinesDto(lines=read_api_log_tail(lines=min(tail, MAX_TAIL)))


@router.delete("/api", response_model=OkDto)
async def clear_workspace_api_logs() -> OkDto:
    path = get_api_log_path()
    if path is not None:
        _clear_log_file(path)
    return OkDto(ok=True)
