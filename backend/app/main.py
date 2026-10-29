import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.ai.runtime import llama_server
from app.api import ai_chat as ai_chat_api
from app.api import ai_model as ai_model_api
from app.api import ai_proposal_apply as ai_proposal_apply_api
from app.api import ai_proposals as ai_proposals_api
from app.api import ai_query as ai_query_api
from app.api import column_lineage as column_lineage_api
from app.api import dashboards as dashboards_api
from app.api import debug as debug_api
from app.api import docs as docs_api
from app.api import document as document_api
from app.api import drift as drift_api
from app.api import env as env_api
from app.api import events as events_api
from app.api import exports as exports_api
from app.api import files as files_api
from app.api import freshness as freshness_api
from app.api import git as git_api
from app.api import global_env as global_env_api
from app.api import global_profiles as global_profiles_api
from app.api import health as health_api
from app.api import health_summary as health_summary_api
from app.api import impact as impact_api
from app.api import init as init_api
from app.api import init_script_test as init_script_test_api
from app.api import license as license_api
from app.api import logs as logs_api
from app.api import metric_monitors as metric_monitors_api
from app.api import models as models_api
from app.api import performance as performance_api
from app.api import projects as projects_api
from app.api import propagation as propagation_api
from app.api import refactor as refactor_api
from app.api import runs as runs_api
from app.api import semantic as semantic_api
from app.api import settings as settings_api
from app.api import setup as setup_api
from app.api import sql as sql_api
from app.api import terminal as terminal_api
from app.api import test_gaps as test_gaps_api
from app.api import workspace as workspace_api
from app.config import settings
from app.db.engine import SessionLocal
from app.db.migrations import init_db
from app.dbt.python_env import load_python_setting
from app.logging_setup import configure_logging, get_logger
from app.logs.api_logger import append_api_log, configure_api_log
from app.projects.service import begin_startup_scan, rescan_projects
from app.semantic import monitors as metric_monitors
from app.semantic.runtime import metricflow_runtime
from app.watcher.service import watcher_manager

_api_log_path = configure_api_log(settings.data_dir)
configure_logging(settings.log_level)
log = get_logger(__name__)


async def _startup_scan() -> None:
    """Rescan the workspace after the server is up, then point the watcher at the result."""
    try:
        async with SessionLocal() as session:
            await rescan_projects(session)
    except Exception as exc:  # noqa: BLE001 — error is logged/reported below
        log.warning("startup_scan_failed", error=str(exc))
    await watcher_manager.resync()


@asynccontextmanager
async def lifespan(app: FastAPI):
    started = time.perf_counter()
    await init_db()
    async with SessionLocal() as session:
        await load_python_setting(session)
        await setup_api.seed_setup_completed(session)
    log.info(
        "startup",
        workspace=str(settings.dbt_projects_path),
        db=settings.resolved_database_url(),
        duration_ms=round((time.perf_counter() - started) * 1000),
    )
    await watcher_manager.start()
    begin_startup_scan(_startup_scan())
    metric_monitors.start_scheduler()
    try:
        yield
    finally:
        await metric_monitors.stop_scheduler()
        await watcher_manager.stop()
        await llama_server.stop()
        await metricflow_runtime.stop()
        log.info("shutdown")


app = FastAPI(title="wickd", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_api.router)
app.include_router(settings_api.router)
app.include_router(setup_api.router)
app.include_router(projects_api.router)
app.include_router(models_api.router)
app.include_router(document_api.router)
app.include_router(debug_api.router)
app.include_router(health_summary_api.router)
app.include_router(drift_api.router)
app.include_router(freshness_api.router)
app.include_router(column_lineage_api.router)
app.include_router(propagation_api.router)
app.include_router(test_gaps_api.router)
app.include_router(semantic_api.router)
app.include_router(metric_monitors_api.router)
app.include_router(dashboards_api.router)
app.include_router(refactor_api.router)
app.include_router(exports_api.router)
app.include_router(exports_api.global_router)
app.include_router(ai_model_api.router)
app.include_router(ai_chat_api.router)
app.include_router(ai_proposals_api.router)
app.include_router(ai_proposal_apply_api.router)
app.include_router(ai_query_api.router)
app.include_router(impact_api.router)
app.include_router(runs_api.router)
app.include_router(performance_api.router)
app.include_router(sql_api.router)
app.include_router(init_api.router)
app.include_router(init_api.global_router)
app.include_router(init_script_test_api.router)
app.include_router(license_api.router)
app.include_router(env_api.router)
app.include_router(docs_api.router)
app.include_router(events_api.router)
app.include_router(files_api.router)
app.include_router(files_api.fs_router)
app.include_router(global_profiles_api.router)
app.include_router(global_env_api.router)
app.include_router(logs_api.router)
app.include_router(terminal_api.router)
app.include_router(git_api.router)
app.include_router(workspace_api.router)


_PROJECT_ID_RE = re.compile(r"/api/projects/(\d+)/")


@app.middleware("http")
async def _log_requests(request: Request, call_next):
    start = time.monotonic()
    response = await call_next(request)
    elapsed_ms = int((time.monotonic() - start) * 1000)
    # Skip SSE streams and noisy health checks from the log file
    if not request.url.path.endswith("/events") and request.url.path != "/api/health":
        line = f"{request.method} {request.url.path} → {response.status_code} ({elapsed_ms}ms)"
        m = _PROJECT_ID_RE.search(request.url.path)
        project_id = int(m.group(1)) if m else None
        append_api_log(line, project_id=project_id)
    return response


def _mount_spa() -> None:
    # Mount static docs directory (created on demand when docs are generated)
    docs_dir = settings.data_dir / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/static/docs", StaticFiles(directory=docs_dir), name="static_docs")

    dist = settings.frontend_dist
    if not dist.exists():
        log.warning("frontend_dist_missing", path=str(dist))
        return
    assets = dist / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    index_file = dist / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        candidate = dist / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index_file)


_mount_spa()
