"""Contract checks (wickd Pro, plan 05): breaking changes in the Impact tab's Uncommitted / Branch modes.

POST /impact/contracts starts a background check of the changed models:

1. the change set (api/impact.py load_change_set) → changed models;
2. the working copy compiled for them, their parents and children, into the data dir
   (revisions.compiled_manifest(ref=None), so the project's target/ isn't touched);
3. the base — HEAD for `working`, the merge base for `branch` — compiled in a worktree for the
   changed models and their parents (cached per commit and selection);
4. with `types`, the columns' data types of both sides' compiled SQL (contract_types.py);
5. wickd_pro.contracts (app/dbt/contracts.py) with the lineage snapshot and the dashboards /
   monitors per metric (contract_usage.py).

A base that can't be compiled leaves only the contract self-check, with a note. Events:
contract_check_started / contract_check_progress (phase) / contract_check_finished. Never blocks anything (no commit hook).
`dbt_state_contract` is always null until plan 18 provides a state directory to compare with.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.impact import NotARepo, load_change_set
from app.api.init import load_project_env
from app.db.engine import get_session
from app.db.models import ColumnLineageSnapshot, ContractCheckSnapshot, Project
from app.dbt import contract_types, contracts
from app.dbt.contract_usage import semantic_consumers
from app.dbt.revisions import RevisionError, compiled_manifest
from app.events.bus import Event, bus
from app.git.changeset import ChangeSetError
from app.licensing.gating import require_pro
from app.logging_setup import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["contracts"])

Scope = Literal["working", "branch"]
_running: dict[int, asyncio.Task] = {}


class StartContractCheckDto(BaseModel):
    scope: Scope = "working"
    base: str | None = Field(default=None, max_length=255)
    types: bool = False


class ContractCheckDto(BaseModel):
    id: int
    project_id: int
    scope: Scope
    base: str | None
    base_sha: str | None
    types: bool
    status: str  # running | done | error
    phase: str | None
    target: str | None
    started_at: str
    finished_at: str | None
    results: list[dict[str, Any]]
    notes: list[str]
    lineage_used: bool
    error_message: str | None


def _loads(raw: str | None, default: Any) -> Any:
    try:
        value = json.loads(raw or "")
    except ValueError:
        return default
    return value if isinstance(value, type(default)) else default


def _to_dto(snap: ContractCheckSnapshot) -> ContractCheckDto:
    return ContractCheckDto(
        id=snap.id, project_id=snap.project_id, scope=snap.scope, base=snap.base,  # type: ignore[arg-type]
        base_sha=snap.base_sha[:7] if snap.base_sha else None, types=bool(snap.types), status=snap.status,
        phase=snap.phase, target=snap.target,
        started_at=snap.started_at.isoformat() if snap.started_at else "",
        finished_at=snap.finished_at.isoformat() if snap.finished_at else None,
        results=_loads(snap.results_json, []), notes=_loads(snap.notes_json, []),
        lineage_used=bool(snap.lineage_used), error_message=snap.error_message,
    )


async def _gate(session: AsyncSession) -> None:
    await require_pro(session, available=contracts.is_available, unavailable_detail=contracts.UNAVAILABLE)


@router.post("/{project_id}/impact/contracts", status_code=202, response_model=ContractCheckDto)
async def start_contract_check(
    project_id: int, dto: StartContractCheckDto, session: AsyncSession = Depends(get_session),
) -> ContractCheckDto:
    await _gate(session)
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    existing = _running.get(project_id)
    if existing is not None and not existing.done():
        raise HTTPException(status_code=409, detail="a contract check is already running for this project")
    env = await load_project_env(project_id)
    snap = ContractCheckSnapshot(
        project_id=project_id, scope=dto.scope, base=dto.base if dto.scope == "branch" else None,
        types=dto.types, status="running", phase="changes", target=env.get("DBT_TARGET"),
    )
    session.add(snap)
    await session.commit()
    await session.refresh(snap)
    # a detached copy: the request's session is closed while the job runs
    detached = Project(id=project.id, name=project.name, path=project.path)
    _running[project_id] = asyncio.create_task(_run_check(detached, snap.id, dto, env))
    return _to_dto(snap)


@router.get("/{project_id}/impact/contracts", response_model=ContractCheckDto | None)
async def get_latest_contract_check(
    project_id: int,
    scope: Scope = Query("working"),
    session: AsyncSession = Depends(get_session),
) -> ContractCheckDto | None:
    await _gate(session)
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    snap = (await session.execute(
        select(ContractCheckSnapshot)
        .where(ContractCheckSnapshot.project_id == project_id, ContractCheckSnapshot.scope == scope)
        .order_by(ContractCheckSnapshot.id.desc()).limit(1)
    )).scalar_one_or_none()
    return _to_dto(snap) if snap else None


# ── the job ──────────────────────────────────────────────────────────────────


class CheckFailed(Exception):
    pass


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def changed_models(manifest: dict, unique_ids: list[str]) -> list[tuple[str, str]]:
    """(unique_id, name) of the changed nodes that are models of the root project."""
    root = (manifest.get("metadata") or {}).get("project_name")
    nodes = manifest.get("nodes") or {}
    return [
        (uid, str(nodes[uid].get("name")))
        for uid in unique_ids
        if uid in nodes and nodes[uid].get("resource_type") == "model"
        and (root is None or nodes[uid].get("package_name") in (None, root))
    ]


def head_selection(names: list[str]) -> str:
    return " ".join(f"1+{n}+1" for n in sorted(set(names)))


def base_selection(names: list[str]) -> str:
    return " ".join(f"1+{n}" for n in sorted(set(names)))


async def _phase(project_id: int, snap_id: int, phase: str) -> None:
    from app.db.engine import SessionLocal

    async with SessionLocal() as session:
        snap = await session.get(ContractCheckSnapshot, snap_id)
        if snap is not None:
            snap.phase = phase
            await session.commit()
    await bus.publish(Event(topic=f"project:{project_id}", type="contract_check_progress",
                            data={"snapshot_id": snap_id, "phase": phase}))


async def _lineage(project_id: int) -> tuple[dict, dict]:
    from app.db.engine import SessionLocal

    async with SessionLocal() as session:
        snap = (await session.execute(
            select(ColumnLineageSnapshot)
            .where(ColumnLineageSnapshot.project_id == project_id, ColumnLineageSnapshot.status == "done")
            .order_by(ColumnLineageSnapshot.id.desc()).limit(1)
        )).scalar_one_or_none()
    if snap is None:
        return {}, {}
    return _loads(snap.results_json, {}), _loads(snap.row_dependencies_json, {})


async def _base_manifest(project: Project, ref: str, names: list[str], notes: list[str]) -> tuple[dict | None, str | None]:
    try:
        side = await compiled_manifest(project, ref=ref, select=base_selection(names))
    except RevisionError as exc:
        label = ref[:7] if len(ref) == 40 else ref
        notes.append(f"Couldn't compile {label} to compare with ({exc.message.strip().splitlines()[-1][:300]}), "
                     "so only enforced contracts were checked, not changes for consumers.")
        return None, None
    notes.extend(side.notes)
    return await asyncio.to_thread(_read_json, side.path), side.sha


async def _probe_types(project: Project, models: list[str], head: dict, base: dict | None,
                       env: dict[str, str], notes: list[str]) -> dict:
    queries: dict[str, str] = {}
    for side, manifest in (("head", head), ("base", base or {})):
        for uid in models:
            sql = ((manifest.get("nodes") or {}).get(uid) or {}).get("compiled_code")
            if sql:
                queries[f"{side}:{uid}"] = sql
    found, errors = await contract_types.probe_query_types(project.id, Path(project.path), queries, env, env.get("DBT_TARGET"))
    if errors:
        failed = sorted({key.split(":", 1)[1].split(".")[-1] for key in errors})
        notes.append(f"Couldn't read column types for {', '.join(failed[:5])}: {next(iter(errors.values()))[-300:]}")
    types: dict[str, dict] = {"head": {}, "base": {}}
    for key, cols in found.items():
        side, uid = key.split(":", 1)
        types[side][uid] = cols
    return types


async def _check(project: Project, snap_id: int, dto: StartContractCheckDto, env: dict[str, str]) -> dict:
    from app.db.engine import SessionLocal

    try:
        changes = await load_change_set(project, dto.scope, dto.base)
    except NotARepo as exc:
        raise CheckFailed("This project isn't in a git repository.") from exc
    except ChangeSetError as exc:
        raise CheckFailed(str(exc)) from exc
    current = await asyncio.to_thread(_read_json, Path(project.path) / "target" / "manifest.json")
    models = changed_models(current, list(changes.mapping.nodes))
    notes: list[str] = []
    if not models:
        return {"results": [], "notes": notes, "base": changes.base, "base_sha": None, "lineage": False}

    names = [name for _, name in models]
    uids = [uid for uid, _ in models]
    await _phase(project.id, snap_id, "compiling_head")
    try:
        head_side = await compiled_manifest(project, ref=None, select=head_selection(names))
    except RevisionError as exc:
        raise CheckFailed(f"dbt compile failed for your changes: {exc.message}") from exc
    head = await asyncio.to_thread(_read_json, head_side.path)

    await _phase(project.id, snap_id, "compiling_base")
    ref = "HEAD" if dto.scope == "working" else (changes.merge_base or "HEAD")
    base, base_sha = await _base_manifest(project, ref, names, notes)

    types = None
    if dto.types:
        await _phase(project.id, snap_id, "types")
        types = await _probe_types(project, uids, head, base, env, notes)

    await _phase(project.id, snap_id, "checking")
    lineage, row_deps = await _lineage(project.id)
    if not lineage:
        notes.append("No column lineage yet, so consumers beyond direct children aren't followed. "
                     "Load column lineage (Columns in Selection mode) for the full reach.")
    async with SessionLocal() as session:
        consumers = await semantic_consumers(session, project.id, Path(project.path))
    results = await asyncio.to_thread(contracts.check_contracts, head, base, uids, lineage, row_deps, consumers, types)
    return {
        "results": [{**r, "dbt_state_contract": None} for r in results],
        "notes": notes, "base": changes.base or ref, "base_sha": base_sha, "lineage": bool(lineage),
    }


async def _finish(snap_id: int, **fields: Any) -> None:
    from app.db.engine import SessionLocal

    async with SessionLocal() as session:
        snap = await session.get(ContractCheckSnapshot, snap_id)
        if snap is None:
            return
        for key, value in fields.items():
            setattr(snap, key, value)
        snap.finished_at = datetime.now(UTC)
        snap.phase = None
        await session.commit()


async def _run_check(project: Project, snap_id: int, dto: StartContractCheckDto, env: dict[str, str]) -> None:
    topic = f"project:{project.id}"
    await bus.publish(Event(topic=topic, type="contract_check_started",
                            data={"snapshot_id": snap_id, "scope": dto.scope, "types": dto.types}))
    counts = {"errors": 0, "warnings": 0}
    ok = True
    try:
        out = await _check(project, snap_id, dto, env)
        results = out["results"]
        counts = {"errors": sum(r["severity"] == "error" for r in results),
                  "warnings": sum(r["severity"] == "warning" for r in results)}
        await _finish(snap_id, status="done", results_json=json.dumps(results), notes_json=json.dumps(out["notes"]),
                      base=out["base"], base_sha=out["base_sha"], lineage_used=out["lineage"])
    except CheckFailed as exc:
        ok = False
        await _finish(snap_id, status="error", error_message=str(exc)[-2000:])
    except Exception as exc:
        ok = False
        log.exception("contract_check_failed", project_id=project.id, snapshot_id=snap_id)
        await _finish(snap_id, status="error", error_message=f"The contract check failed: {exc}"[-2000:])
    await bus.publish(Event(topic=topic, type="contract_check_finished",
                            data={"snapshot_id": snap_id, "scope": dto.scope, "ok": ok, **counts}))
