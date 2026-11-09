import asyncio
import json
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import ColumnLineageSnapshot, Project
from app.dbt import column_lineage
from app.dbt.column_lineage import (
    ColumnLineageUnavailable,
    LineageJob,
    prepare_lineage_jobs,
    trace_job_structure,
)
from app.dbt.lineage_cache import (
    current_tracer,
    latest_done,
    latest_snapshot,
    manifest_path,
    staleness,
)
from app.dbt.lineage_freshness import JobPlan, carry_over, current_fingerprint, plan_jobs
from app.events.bus import Event, bus
from app.licensing.gating import require_pro
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["column-lineage"])

# In-memory map of project_id → running asyncio.Task (prevents concurrent runs)
_running: dict[int, asyncio.Task] = {}

# Column lineage tracing (sqlglot.lineage.lineage()) is CPU-bound. Fan work out
# across a small pool of worker processes so a large project doesn't take
# minutes on a single core and doesn't starve the event loop.
_POOL_SIZE = max(1, min(8, (os.cpu_count() or 2) - 1))

LINEAGE_VERSION = column_lineage.LINEAGE_VERSION


def _current_lineage_version() -> int:
    return column_lineage.current_lineage_version()


_pool = ProcessPoolExecutor(max_workers=_POOL_SIZE)


class ColumnLineageEntryDto(BaseModel):
    node: str
    column: str
    # how the column is derived from this ref: identity | rename | cast | derived
    # (projection refs from lineage_version 3 on; None otherwise)
    kind: str | None = None


class ColumnLineageSnapshotDto(BaseModel):
    id: int
    project_id: int
    started_at: str
    finished_at: str | None
    status: str  # running | done | error
    total_models: int
    checked_models: int
    results: dict[str, dict[str, list[ColumnLineageEntryDto]]]
    # upstream columns each model filters / joins / groups on (empty for lineage_version 1)
    row_dependencies: dict[str, list[ColumnLineageEntryDto]] = {}
    lineage_version: int = 1
    error_message: str | None
    # The latest finished snapshot is served as the cache. stale: the project changed since it was
    # traced (content, not manifest mtime; app/dbt/lineage_freshness.py), so offer a refresh.
    stale: bool = False
    stale_reason: str | None = None
    # A newer scan than this one: running, or error (refresh_error says why). None = no newer scan.
    refresh_status: str | None = None
    refresh_error: str | None = None


class ColumnLineageStatusDto(BaseModel):
    """The cache's state without its (large) results: for controls that only need to know whether
    to offer Load / Refresh."""
    snapshot_id: int | None = None
    status: str | None = None  # the cached snapshot's status; None = never scanned
    lineage_version: int | None = None
    total_models: int = 0
    stale: bool = False
    stale_reason: str | None = None
    refresh_status: str | None = None
    refresh_error: str | None = None
    error_message: str | None = None


def _to_utc_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.isoformat()


def _manifest_needs_compile(manifest_path: Path) -> bool:
    """True if any model in this manifest lacks compiled SQL — e.g. it came from
    `dbt parse`, or from a selective command (`dbt run -s x` keeps compiled_code
    only for the nodes it ran). prepare_lineage_jobs() silently skips models
    without compiled_code (the only source of per-model SQL it traces), so a
    scan of such a manifest would drop their lineage without any error."""
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    nodes = data.get("nodes") or {}
    models = [n for n in nodes.values() if n.get("resource_type") == "model"]
    if not models:
        return False
    return not all(n.get("compiled_code") or n.get("compiled_sql") for n in models)


async def _require_pro(session: AsyncSession) -> None:
    """Column-level lineage is a wickd Pro feature. Gates all three routes
    below (start + both read routes) — not just start — because an already-
    computed ColumnLineageSnapshot persists in the DB indefinitely, so a
    lapsed subscription could otherwise keep reading old results forever
    just by never re-triggering a scan."""
    await require_pro(session)


def _snapshot_to_dto(snap: ColumnLineageSnapshot) -> ColumnLineageSnapshotDto:
    try:
        raw: dict = json.loads(snap.results_json)
    except (json.JSONDecodeError, TypeError):
        raw = {}

    results = {
        uid: {
            col: [ColumnLineageEntryDto(**ref) for ref in refs]
            for col, refs in col_map.items()
        }
        for uid, col_map in raw.items()
    }
    try:
        raw_rows: dict = json.loads(snap.row_dependencies_json or "{}")
    except (json.JSONDecodeError, TypeError):
        raw_rows = {}
    row_dependencies = {uid: [ColumnLineageEntryDto(**ref) for ref in refs] for uid, refs in raw_rows.items()}
    return ColumnLineageSnapshotDto(
        id=snap.id,
        project_id=snap.project_id,
        started_at=_to_utc_iso(snap.started_at) if snap.started_at else "",
        finished_at=_to_utc_iso(snap.finished_at) if snap.finished_at else None,
        status=snap.status,
        total_models=snap.total_models,
        checked_models=snap.checked_models,
        results=results,
        row_dependencies=row_dependencies,
        lineage_version=snap.lineage_version or 1,
        error_message=snap.error_message,
    )


@router.post("/{project_id}/column-lineage/start", status_code=202, response_model=ColumnLineageSnapshotDto)
async def start_column_lineage(
    project_id: int,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> ColumnLineageSnapshotDto:
    await _require_pro(session)

    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    existing_task = _running.get(project_id)
    if existing_task is not None and not existing_task.done():
        raise HTTPException(status_code=409, detail="column lineage scan already running for this project")

    manifest = manifest_path(project.path)
    try:
        manifest_mtime = manifest.stat().st_mtime
    except OSError:
        raise HTTPException(status_code=422, detail="manifest not found — run dbt compile first")

    # The cache: if the latest finished snapshot still matches the project's content
    # (not the manifest's mtime — dbt rewrites it on every command), serve it.
    cached = await latest_done(session, project_id)
    if cached is not None and await staleness(project.path, cached) is None:
        response.status_code = 200
        return _snapshot_to_dto(cached)

    needs_compile = _manifest_needs_compile(manifest)

    # A placeholder "running" snapshot with unknown totals — prepare_lineage_jobs()
    # (and, if needed, dbt compile first) both happen inside the background task
    # below, not here, so this endpoint stays fast (202-style) even on a large
    # project or a slow compile. The frontend keeps showing the cached snapshot
    # and gets progress via the column_lineage_compiling/_progress SSE events.
    snap = ColumnLineageSnapshot(
        project_id=project_id,
        status="running",
        total_models=0,
        checked_models=0,
        results_json="{}",
        manifest_mtime=manifest_mtime,
        lineage_version=_current_lineage_version(),
    )
    session.add(snap)
    await session.commit()
    await session.refresh(snap)
    snap_id = snap.id

    task = asyncio.create_task(
        _compile_then_run_column_lineage(project_id, snap_id, project.path, manifest, needs_compile)
    )
    _running[project_id] = task

    if needs_compile:
        await bus.publish(Event(topic=f"project:{project_id}", type="column_lineage_compiling", data={}))
    else:
        await bus.publish(Event(
            topic=f"project:{project_id}",
            type="column_lineage_started",
            data={"snapshot_id": snap_id, "total": 0},
        ))

    return _snapshot_to_dto(snap)


@dataclass(frozen=True)
class _CacheView:
    cached: ColumnLineageSnapshot | None  # latest finished
    newest: ColumnLineageSnapshot | None  # latest in any status
    stale_reason: str | None

    @property
    def refresh(self) -> ColumnLineageSnapshot | None:
        """A scan newer than the cache (running, or failed)."""
        if self.cached is None or self.newest is None or self.newest.id == self.cached.id:
            return None
        return self.newest

    def cache_fields(self) -> dict:
        refresh = self.refresh
        return {
            "stale": self.stale_reason is not None,
            "stale_reason": self.stale_reason,
            "refresh_status": refresh.status if refresh else None,
            "refresh_error": refresh.error_message if refresh and refresh.status == "error" else None,
        }


async def _cache_view(session: AsyncSession, project_id: int) -> _CacheView:
    await _require_pro(session)
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    cached = await latest_done(session, project_id)
    newest = await latest_snapshot(session, project_id)
    reason = await staleness(project.path, cached) if cached is not None else None
    return _CacheView(cached=cached, newest=newest, stale_reason=reason)


@router.get("/{project_id}/column-lineage", response_model=ColumnLineageSnapshotDto | None)
async def get_latest_column_lineage(
    project_id: int,
    session: AsyncSession = Depends(get_session),
) -> ColumnLineageSnapshotDto | None:
    """The cached (latest finished) snapshot with whether it's out of date and the state of any
    newer scan; the newest snapshot itself when none has finished yet."""
    view = await _cache_view(session, project_id)
    if view.cached is None:
        return _snapshot_to_dto(view.newest) if view.newest else None
    return _snapshot_to_dto(view.cached).model_copy(update=view.cache_fields())


@router.get("/{project_id}/column-lineage/status", response_model=ColumnLineageStatusDto)
async def get_column_lineage_status(
    project_id: int,
    session: AsyncSession = Depends(get_session),
) -> ColumnLineageStatusDto:
    """get_latest_column_lineage() without the results."""
    view = await _cache_view(session, project_id)
    snap = view.cached or view.newest
    if snap is None:
        return ColumnLineageStatusDto()
    return ColumnLineageStatusDto(
        snapshot_id=snap.id,
        status=snap.status,
        lineage_version=snap.lineage_version or 1,
        total_models=snap.total_models,
        error_message=snap.error_message,
        **(view.cache_fields() if view.cached is not None else {}),
    )


@router.get("/{project_id}/column-lineage/{snapshot_id}", response_model=ColumnLineageSnapshotDto)
async def get_column_lineage_snapshot(
    project_id: int,
    snapshot_id: int,
    session: AsyncSession = Depends(get_session),
) -> ColumnLineageSnapshotDto:
    await _require_pro(session)

    snap = await session.get(ColumnLineageSnapshot, snapshot_id)
    if snap is None or snap.project_id != project_id:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return _snapshot_to_dto(snap)


async def _compile_then_run_column_lineage(
    project_id: int,
    snap_id: int,
    project_path: str,
    manifest_path: Path,
    needs_compile: bool,
) -> None:
    """Background task started by start_column_lineage(). Runs `dbt compile`
    first if the manifest had no compiled SQL, then re-reads the (now fresh)
    manifest, builds the jobs list, and hands off to _run_column_lineage() for
    the actual per-model tracing — all off the request path so the endpoint
    itself stays fast regardless of how long compile or a large project's
    trace takes."""
    from app.db.engine import SessionLocal

    topic = f"project:{project_id}"

    async def _fail(message: str) -> None:
        async with SessionLocal() as session:
            snap = await session.get(ColumnLineageSnapshot, snap_id)
            if snap is not None:
                snap.status = "error"
                snap.finished_at = datetime.now(UTC)
                snap.error_message = message
                await session.commit()
        await bus.publish(Event(
            topic=topic,
            type="column_lineage_finished",
            data={"snapshot_id": snap_id, "ok": False},
        ))

    if needs_compile:
        from app.api.models import _compile_project

        ok = await _compile_project(project_id, project_path)
        if not ok:
            await _fail("dbt compile failed — check Project Logs for details, then retry column lineage.")
            return

    try:
        manifest_mtime = manifest_path.stat().st_mtime
    except OSError:
        await _fail("manifest not found — run dbt compile first")
        return

    loop = asyncio.get_event_loop()
    # Fingerprint before building jobs: if the manifest changes in between, the stored
    # fingerprint is the older one and the snapshot reads as stale (never falsely fresh).
    fingerprint = await loop.run_in_executor(None, current_fingerprint, manifest_path)
    try:
        jobs: list[LineageJob] = await loop.run_in_executor(None, prepare_lineage_jobs, manifest_path)
    except ColumnLineageUnavailable as exc:
        await _fail(str(exc))
        return

    tracer = current_tracer()
    async with SessionLocal() as session:
        previous = await latest_done(session, project_id)
        previous_data = _previous_results(previous)
        plan = plan_jobs(jobs, tracer, previous_data.job_keys)
        snap = await session.get(ColumnLineageSnapshot, snap_id)
        if snap is not None:
            snap.total_models = len(jobs)
            snap.checked_models = len(plan.reused)
            snap.manifest_mtime = manifest_mtime
            await session.commit()

    log.info("column_lineage_plan", project_id=project_id, total=len(jobs), reused=len(plan.reused))
    await bus.publish(Event(
        topic=topic,
        type="column_lineage_started",
        data={"snapshot_id": snap_id, "total": len(jobs), "reused": len(plan.reused)},
    ))

    await _run_column_lineage(
        project_id, snap_id, plan, previous_data, manifest_mtime,
        fingerprint.to_json(tracer) if fingerprint is not None else "",
    )


@dataclass(frozen=True)
class _PreviousResults:
    """A finished snapshot's per-model results, for carrying over unchanged models."""
    job_keys: dict[str, str] = field(default_factory=dict)
    results: dict = field(default_factory=dict)
    rows: dict = field(default_factory=dict)
    structure: dict = field(default_factory=dict)


def _previous_results(snap: ColumnLineageSnapshot | None) -> _PreviousResults:
    if snap is None:
        return _PreviousResults()
    return _PreviousResults(
        job_keys=_loads_dict(snap.job_keys_json),
        results=_loads_dict(snap.results_json),
        rows=_loads_dict(snap.row_dependencies_json),
        structure=_loads_dict(snap.join_keys_json),
    )


def _loads_dict(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _ref_json(ref, kind: str | None) -> dict:
    entry = {"node": ref.node, "column": ref.column}
    if kind is not None:
        entry["kind"] = kind
    return entry


async def _run_column_lineage(
    project_id: int,
    snap_id: int,
    plan: JobPlan,
    previous: _PreviousResults,
    manifest_mtime: float,
    fingerprint_json: str,
) -> None:
    from app.db.engine import SessionLocal

    topic = f"project:{project_id}"
    total = len(plan.keys)
    loop = asyncio.get_event_loop()

    # Unchanged models keep the previous scan's results; only plan.to_trace is traced.
    results: dict[str, dict] = carry_over(previous.results, plan.reused)
    row_results: dict[str, list] = carry_over(previous.rows, plan.reused)
    structure_results: dict[str, dict] = carry_over(previous.structure, plan.reused)
    checked = len(plan.reused)
    failed: set[str] = set()
    error_message: str | None = None

    try:
        future_to_job = {
            loop.run_in_executor(_pool, trace_job_structure, job): job
            for job in plan.to_trace
        }

        # asyncio.as_completed()'s plain-iteration form yields a *new* coroutine
        # each time (not the original future), which breaks a future→job
        # lookup dict; its async-iteration form (which preserves identity) is
        # only available on 3.13+. asyncio.wait(..., FIRST_COMPLETED) is the
        # version-portable way to fan out work while still being able to map
        # each completed future back to the job it ran.
        pending = set(future_to_job.keys())
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for fut in done:
                job = future_to_job[fut]
                try:
                    uid, col_lineage, row_refs, structure = fut.result()
                    if col_lineage:
                        results[uid] = {
                            col: [_ref_json(ref, kind) for ref, kind in refs]
                            for col, refs in col_lineage.items()
                        }
                    if row_refs:
                        row_results[uid] = [{"node": ref.node, "column": ref.column} for ref in row_refs]
                    if structure.get("join_pairs") or structure.get("grain"):
                        structure_results[uid] = structure
                except Exception as exc:  # noqa: BLE001 — error is logged/reported below
                    failed.add(job.uid)  # no key stored, so the next refresh retries it
                    log.warning("column_lineage_job_failed", uid=job.uid, error=str(exc))

                checked += 1

                # Progress only: results are written once at the end (readers use the
                # latest finished snapshot, and re-serializing every result per model
                # made large projects quadratic).
                async with SessionLocal() as session:
                    snap = await session.get(ColumnLineageSnapshot, snap_id)
                    if snap is not None:
                        snap.checked_models = checked
                        await session.commit()

                await bus.publish(Event(
                    topic=topic,
                    type="column_lineage_progress",
                    data={
                        "snapshot_id": snap_id,
                        "checked": checked,
                        "total": total,
                        "current": job.name,
                    },
                ))
    except Exception as exc:  # noqa: BLE001 — error is logged/reported below
        error_message = str(exc)

    final_status = "error" if error_message else "done"

    async with SessionLocal() as session:
        snap = await session.get(ColumnLineageSnapshot, snap_id)
        if snap is not None:
            snap.status = final_status
            snap.finished_at = datetime.now(UTC)
            snap.checked_models = checked
            snap.results_json = json.dumps(results)
            snap.row_dependencies_json = json.dumps(row_results)
            snap.join_keys_json = json.dumps(structure_results)
            snap.error_message = error_message
            snap.manifest_mtime = manifest_mtime
            snap.fingerprint_json = fingerprint_json if final_status == "done" else ""
            snap.job_keys_json = json.dumps({uid: key for uid, key in plan.keys.items() if uid not in failed})
            await session.commit()

    await bus.publish(Event(
        topic=topic,
        type="column_lineage_finished",
        data={"snapshot_id": snap_id, "ok": error_message is None},
    ))
