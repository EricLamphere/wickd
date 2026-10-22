import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_session
from app.db.models import DriftSnapshot, Project
from app.dbt.drift import (
    ModelDriftResult,
    diff_columns,
    is_eligible_for_drift_check,
    skipped_counts,
)
from app.dbt.manifest import ModelNode, load_manifest
from app.dbt.probe import ProbeResult, probe_many_warehouse_columns, probe_warehouse_columns
from app.events.bus import Event, bus

router = APIRouter(prefix="/api/projects", tags=["drift"])

# Models probed per dbt invocation: each invocation pays dbt's parse + connect
# startup, so batching is what makes the scan fast (dbt can't run in parallel
# per project). Smaller batches only mean coarser progress and a cheaper fallback.
PROBE_BATCH_SIZE = 25

# In-memory map of project_id → running asyncio.Task (prevents concurrent runs)
_running: dict[int, asyncio.Task] = {}


class ColumnDriftDto(BaseModel):
    name: str
    in_manifest: bool
    in_warehouse: bool
    manifest_type: str
    warehouse_type: str
    type_mismatch: bool


class ModelDriftResultDto(BaseModel):
    unique_id: str
    name: str
    materialized: str | None
    error: str | None
    columns: list[ColumnDriftDto]
    has_drift: bool
    not_built: bool = False
    yaml_path: str | None = None  # project-relative schema YAML, for "Open YAML"


class DriftSnapshotDto(BaseModel):
    id: int
    project_id: int
    started_at: str
    finished_at: str | None
    status: str  # running | done | error
    target: str | None
    total_models: int
    checked_models: int
    results: list[ModelDriftResultDto]
    error_message: str | None
    skipped: dict[str, int]  # models the scan doesn't check, by materialization


class StartDriftDto(BaseModel):
    select: list[str] | None = None  # optional: limit to subset of unique_ids


class RecheckDriftDto(BaseModel):
    unique_id: str


def _to_utc_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _snapshot_to_dto(snap: DriftSnapshot) -> DriftSnapshotDto:
    try:
        raw_results: list[dict] = json.loads(snap.results_json)
    except Exception:
        raw_results = []

    results = [
        ModelDriftResultDto(
            unique_id=r.get("unique_id", ""),
            name=r.get("name", ""),
            materialized=r.get("materialized"),
            error=r.get("error"),
            columns=[ColumnDriftDto(**c) for c in r.get("columns", [])],
            has_drift=r.get("has_drift", False),
            not_built=r.get("not_built", False),
            yaml_path=r.get("yaml_path"),
        )
        for r in raw_results
    ]
    return DriftSnapshotDto(
        id=snap.id,
        project_id=snap.project_id,
        started_at=_to_utc_iso(snap.started_at) if snap.started_at else "",
        finished_at=_to_utc_iso(snap.finished_at) if snap.finished_at else None,
        status=snap.status,
        target=snap.target,
        total_models=snap.total_models,
        checked_models=snap.checked_models,
        results=results,
        error_message=snap.error_message,
        skipped=_load_skipped(snap.skipped_json),
    )


def _load_skipped(raw: str | None) -> dict[str, int]:
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return {}
    return {str(k): int(v) for k, v in data.items()} if isinstance(data, dict) else {}


@router.post("/{project_id}/drift", status_code=202, response_model=DriftSnapshotDto)
async def start_drift(
    project_id: int,
    dto: StartDriftDto,
    session: AsyncSession = Depends(get_session),
) -> DriftSnapshotDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    existing_task = _running.get(project_id)
    if existing_task is not None and not existing_task.done():
        raise HTTPException(status_code=409, detail="drift check already running for this project")

    manifest_path = Path(project.path) / "target" / "manifest.json"
    loop = asyncio.get_event_loop()
    manifest = await loop.run_in_executor(None, load_manifest, manifest_path)
    if manifest is None:
        raise HTTPException(status_code=422, detail="manifest not found — run dbt compile first")

    eligible = sorted(
        (n for n in manifest.nodes if is_eligible_for_drift_check(n)),
        key=lambda n: n.name,
    )
    if dto.select:
        uid_set = set(dto.select)
        eligible = [n for n in eligible if n.unique_id in uid_set]

    from app.api.init import load_project_env
    env = await load_project_env(project_id)
    target_val = env.get("DBT_TARGET")

    snap = DriftSnapshot(
        project_id=project_id,
        status="running",
        target=target_val,
        total_models=len(eligible),
        checked_models=0,
        results_json="[]",
        skipped_json=json.dumps(skipped_counts(manifest.nodes)),
    )
    session.add(snap)
    await session.commit()
    await session.refresh(snap)
    snap_id = snap.id

    task = asyncio.create_task(
        _run_drift_check(project_id, snap_id, project.path, eligible, env, target_val)
    )
    _running[project_id] = task

    return _snapshot_to_dto(snap)


@router.get("/{project_id}/drift", response_model=DriftSnapshotDto | None)
async def get_latest_drift(
    project_id: int,
    session: AsyncSession = Depends(get_session),
) -> DriftSnapshotDto | None:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    result = await session.execute(
        select(DriftSnapshot)
        .where(DriftSnapshot.project_id == project_id)
        .order_by(DriftSnapshot.id.desc())
        .limit(1)
    )
    snap = result.scalar_one_or_none()
    return _snapshot_to_dto(snap) if snap else None


@router.get("/{project_id}/drift/{snapshot_id}", response_model=DriftSnapshotDto)
async def get_drift_snapshot(
    project_id: int,
    snapshot_id: int,
    session: AsyncSession = Depends(get_session),
) -> DriftSnapshotDto:
    snap = await session.get(DriftSnapshot, snapshot_id)
    if snap is None or snap.project_id != project_id:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return _snapshot_to_dto(snap)


@router.post("/{project_id}/drift/{snapshot_id}/recheck", response_model=DriftSnapshotDto)
async def recheck_drift_model(
    project_id: int,
    snapshot_id: int,
    dto: RecheckDriftDto,
    session: AsyncSession = Depends(get_session),
) -> DriftSnapshotDto:
    """Re-probe one model and update its row in the snapshot (e.g. after rebuilding it)."""
    project = await session.get(Project, project_id)
    snap = await session.get(DriftSnapshot, snapshot_id)
    if project is None or snap is None or snap.project_id != project_id:
        raise HTTPException(status_code=404, detail="snapshot not found")
    existing_task = _running.get(project_id)
    if snap.status == "running" or (existing_task is not None and not existing_task.done()):
        raise HTTPException(status_code=409, detail="drift check already running for this project")

    project_path = Path(project.path)
    manifest = await asyncio.get_event_loop().run_in_executor(
        None, load_manifest, project_path / "target" / "manifest.json"
    )
    node = next(
        (n for n in (manifest.nodes if manifest else ()) if n.unique_id == dto.unique_id), None
    )
    if node is None or not is_eligible_for_drift_check(node):
        raise HTTPException(status_code=404, detail="model not found or not checked for drift")

    from app.api.init import load_project_env
    env = await load_project_env(project_id)
    probe = await _probe_one(project_id, project_path, node, env, env.get("DBT_TARGET"))
    updated = _result_to_dict(_drift_result(node, probe, project_path))

    try:
        results: list[dict] = json.loads(snap.results_json)
    except ValueError:
        results = []
    results = [r for r in results if r.get("unique_id") != node.unique_id] + [updated]
    results.sort(key=lambda r: r.get("name", ""))
    snap.results_json = json.dumps(results)
    await session.commit()
    await session.refresh(snap)

    await bus.publish(Event(
        topic=f"project:{project_id}",
        type="drift_finished",
        data={
            "snapshot_id": snapshot_id,
            "ok": True,
            "drifted_count": sum(1 for r in results if r.get("has_drift")),
            "recheck": node.unique_id,
        },
    ))
    return _snapshot_to_dto(snap)


async def _run_drift_check(
    project_id: int,
    snap_id: int,
    project_path: str,
    eligible,
    env: dict[str, str],
    target_val: str | None,
) -> None:
    from app.db.engine import SessionLocal

    topic = f"project:{project_id}"
    total = len(eligible)

    await bus.publish(Event(
        topic=topic,
        type="drift_started",
        data={"snapshot_id": snap_id, "total": total},
    ))

    results: list[dict] = []
    checked = 0

    for i in range(0, total, PROBE_BATCH_SIZE):
        batch = eligible[i:i + PROBE_BATCH_SIZE]
        # 1-based, inclusive: the panel shows "Checking 26–50 of N" while the batch runs
        batch_range = {"batch_start": i + 1, "batch_end": i + len(batch)}
        await _publish_progress(topic, snap_id, checked, total, "", batch_range)
        probes = await probe_many_warehouse_columns(
            project_id, Path(project_path), tuple(n.name for n in batch), env, target_val
        )
        for node in batch:
            probe = probes[node.name] if probes is not None else await probe_warehouse_columns(
                project_id, Path(project_path), node.name, env, target_val
            )
            results.append(_result_to_dict(_drift_result(node, probe, Path(project_path))))
            checked += 1
            await _save_progress(snap_id, checked, results)
            await _publish_progress(topic, snap_id, checked, total, node.name, batch_range)

    results.sort(key=lambda r: r.get("name", ""))
    drifted_count = sum(1 for r in results if r.get("has_drift"))

    async with SessionLocal() as session:
        snap = await session.get(DriftSnapshot, snap_id)
        if snap is not None:
            snap.status = "done"
            snap.finished_at = datetime.now(timezone.utc)
            snap.checked_models = checked
            snap.results_json = json.dumps(results)
            await session.commit()

    await bus.publish(Event(
        topic=topic,
        type="drift_finished",
        data={"snapshot_id": snap_id, "ok": True, "drifted_count": drifted_count},
    ))


def _drift_result(node: ModelNode, probe: ProbeResult, project_path: Path) -> ModelDriftResult:
    base = {
        "unique_id": node.unique_id,
        "name": node.name,
        "materialized": node.materialized,
        "yaml_path": _yaml_path(node, project_path),
    }
    if probe.error is not None:
        return ModelDriftResult(
            **base, error=probe.error, columns=(), has_drift=False, not_built=probe.not_built
        )
    drifted_cols = diff_columns(node.columns, probe.columns, probe.types)
    return ModelDriftResult(
        **base,
        error=None,
        columns=drifted_cols,
        has_drift=any(
            not c.in_manifest or not c.in_warehouse or c.type_mismatch for c in drifted_cols
        ),
    )


def _yaml_path(node: ModelNode, project_path: Path) -> str | None:
    """The node's schema YAML relative to the project, if it lives in this project
    (patch_path is `package://path`; package nodes resolve elsewhere, so check it exists)."""
    if not node.patch_path or "://" not in node.patch_path:
        return None
    rel = node.patch_path.split("://", 1)[1]
    return rel if (project_path / rel).is_file() else None


def _result_to_dict(result: ModelDriftResult) -> dict:
    return {
        "unique_id": result.unique_id,
        "name": result.name,
        "materialized": result.materialized,
        "error": result.error,
        "columns": [
            {
                "name": c.name,
                "in_manifest": c.in_manifest,
                "in_warehouse": c.in_warehouse,
                "manifest_type": c.manifest_type,
                "warehouse_type": c.warehouse_type,
                "type_mismatch": c.type_mismatch,
            }
            for c in result.columns
        ],
        "has_drift": result.has_drift,
        "not_built": result.not_built,
        "yaml_path": result.yaml_path,
    }


async def _probe_one(
    project_id: int, project_path: Path, node: ModelNode, env: dict[str, str], target: str | None
) -> ProbeResult:
    probes = await probe_many_warehouse_columns(project_id, project_path, (node.name,), env, target)
    if probes is not None:
        return probes[node.name]
    return await probe_warehouse_columns(project_id, project_path, node.name, env, target)


async def _publish_progress(
    topic: str, snap_id: int, checked: int, total: int, current: str, batch_range: dict[str, int]
) -> None:
    await bus.publish(Event(
        topic=topic,
        type="drift_progress",
        data={
            "snapshot_id": snap_id,
            "checked": checked,
            "total": total,
            "current": current,
            **batch_range,
        },
    ))


async def _save_progress(snap_id: int, checked: int, results: list[dict]) -> None:
    from app.db.engine import SessionLocal

    async with SessionLocal() as session:
        snap = await session.get(DriftSnapshot, snap_id)
        if snap is not None:
            snap.checked_models = checked
            snap.results_json = json.dumps(results)
            await session.commit()
