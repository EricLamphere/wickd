"""Slim builds (plan 18): state source, preview of a state: selection, dbt clone and dbt retry.

- GET  /state             resolve STATE_SOURCE (parses the git ref the first time) → source, sha, age, notes
- POST /state/preview     what `dbt build --select state:…[+]` would run; dbt vs git differences;
                          with `prune` (Pro) the smallest safe selection from column lineage
- POST /clone             `dbt clone --select … --state <dir>` (copies prod relations into dev)
- POST /runs/retry        `dbt retry` of the project's last run (it reads target/run_results.json)

Runs go through api/runs.py (`_run_invocation`), so they're recorded in Run History, stream
run_started / run_log / run_finished, and persist statuses. The sticky "Defer to prod" choice is
the `state_defer` project env var (set with the env var endpoints) and is applied by runs.py.
"""

import asyncio
import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.impact import NotARepo, load_change_set
from app.api.init import load_project_env
from app.api.runs import (
    RunResponseDto,
    _as_utc,
    _InvocationSpec,
    _load_active_profile_name,
    _load_active_target,
    _profiles_default_target,
    _run_invocation,
    latest_invocation_id,
)
from app.db.engine import get_session
from app.db.models import Project, RunInvocation
from app.dbt import slim
from app.dbt.slim_preview import (
    METHODS,
    compare_with_git,
    downstream,
    exact_selector,
    is_buildable,
    list_state,
    node,
    resource_type,
)
from app.dbt.slim_prune import LineageNeeded, smallest_selection
from app.dbt.state import StateDir, StateError, resolve_run_state, state_dir
from app.git.changeset import ChangeSetError
from app.licensing.gating import require_pro

router = APIRouter(prefix="/api/projects", tags=["slim"])

Method = Literal[METHODS]  # type: ignore[valid-type]
# dbt retry only resumes these (and a retry of them)
RETRY_SOURCES = frozenset({"run", "build", "test", "seed", "snapshot", "retry", "clone"})
# run_results.json written this long after the run finished came from a later command
_RESULTS_SLACK_SECONDS = 5.0


class StateDto(BaseModel):
    kind: Literal["git", "path"]
    ref: str | None
    folder: str | None
    sha: str | None
    target: str | None
    generated_at: str | None
    dbt_version: str | None
    notes: list[str]
    # the folders a run passes: --state (what changed) and --defer-state / clone (prod's relations)
    state_path: str = ""
    defer_path: str = ""


class PreviewRequestDto(BaseModel):
    method: Method = "state:modified"
    downstream: bool = True
    scope: Literal["working", "branch"] = "working"
    base: str | None = Field(default=None, max_length=255)
    prune: bool = False


class PreviewNodeDto(BaseModel):
    unique_id: str
    name: str
    resource_type: str
    changed: bool
    selected: bool
    # dbt build does something for it (false for sources, exposures, metrics, semantic models, saved queries)
    buildable: bool = True
    reason: str | None = None
    columns: list[str] | None = None


class PreviewDto(BaseModel):
    state: StateDto
    selector: str            # the state selector dbt was asked for, e.g. state:modified+
    select: str              # what Build should pass to --select (the selector, or the pruned node list)
    needs_state: bool        # the select uses state: methods, so --state must be passed
    nodes: list[PreviewNodeDto]
    tests: int               # tests that ride along with the selected nodes
    pruned: bool
    dbt_only: list[str]      # dbt sees these as changed, git doesn't
    git_only: list[str]      # git changed these files, dbt doesn't see a change
    notes: list[str]
    # prune was asked for, but the column lineage snapshot is missing or stale: load it, then preview again
    lineage_needed: bool = False


class CloneDto(BaseModel):
    select: str = Field(min_length=1, max_length=4096)
    full_refresh: bool = False


class RetryDto(BaseModel):
    invocation_id: int | None = None


def _state_dto(state: StateDir) -> StateDto:
    return StateDto(
        kind=state.kind, ref=state.ref, folder=state.folder, sha=state.sha[:7] if state.sha else None,
        target=state.target, generated_at=state.generated_at, dbt_version=state.dbt_version, notes=list(state.notes),
        state_path=str(state.path), defer_path=str(state.relations_path),
    )


def _bad_state(exc: StateError) -> HTTPException:
    return HTTPException(status_code=400, detail={"error": exc.code, "message": exc.message})


async def _project(session: AsyncSession, project_id: int) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return Project(id=project.id, name=project.name, path=project.path, profile=project.profile)


@router.get("/{project_id}/state", response_model=StateDto)
async def get_state(project_id: int, session: AsyncSession = Depends(get_session)) -> StateDto:
    project = await _project(session, project_id)
    try:
        return _state_dto(await state_dir(project, await load_project_env(project_id)))
    except StateError as exc:
        raise _bad_state(exc) from exc


async def _git_changed(project: Project, dto: PreviewRequestDto, notes: list[str]) -> list[str] | None:
    try:
        changes = await load_change_set(project, dto.scope, dto.base)
    except NotARepo:
        return None
    except ChangeSetError as exc:
        notes.append(f"Couldn't compare with git: {exc}")
        return None
    return list(changes.mapping.nodes.keys())


def _preview_nodes(manifest: dict, candidates: list[str], changed: set[str], pruning: dict | None) -> list[PreviewNodeDto]:
    kept = {k["unique_id"]: k for k in (pruning or {}).get("kept", [])}
    skipped = {s["unique_id"]: s["reason"] for s in (pruning or {}).get("skipped", [])}
    rows = []
    for uid in candidates:
        kind = resource_type(manifest, uid)
        if kind in ("test", "unit_test") and uid not in changed:
            continue
        info = kept.get(uid)
        rows.append(PreviewNodeDto(
            unique_id=uid, name=str(node(manifest, uid).get("name") or uid.split(".")[-1]), resource_type=kind,
            changed=uid in changed, selected=pruning is None or uid in kept, buildable=is_buildable(manifest, uid),
            reason=(info or {}).get("reason") or skipped.get(uid), columns=(info or {}).get("columns"),
        ))
    return rows


@router.post("/{project_id}/state/preview", response_model=PreviewDto)
async def preview_state(project_id: int, dto: PreviewRequestDto, session: AsyncSession = Depends(get_session)) -> PreviewDto:
    if dto.prune:
        await require_pro(session, available=slim.is_available, unavailable_detail=slim.UNAVAILABLE)
    project = await _project(session, project_id)
    env = await load_project_env(project_id)
    notes: list[str] = []
    try:
        state = await state_dir(project, env)
        listed = await list_state(project, env, state, dto.method, await _load_active_target(project_id))
    except StateError as exc:
        raise _bad_state(exc) from exc
    manifest = listed.manifest
    changed = list(listed.unique_ids)
    candidates = downstream(changed, manifest.get("child_map") or {}) if dto.downstream else changed
    selector = f"{dto.method}+" if dto.downstream else dto.method
    pruning = None
    lineage_needed = False
    if dto.prune and dto.downstream and changed:
        try:
            pruning = await smallest_selection(project, state, manifest, changed, candidates, notes)
        except LineageNeeded as exc:
            lineage_needed = True
            notes.append(str(exc))
    git_changed = await _git_changed(project, dto, notes)
    dbt_only, git_only = compare_with_git(manifest, changed, git_changed) if git_changed is not None else ([], [])
    tests = sum(1 for u in candidates if resource_type(manifest, u) in ("test", "unit_test") and u not in changed)
    return PreviewDto(
        state=_state_dto(state), selector=selector,
        select=exact_selector(manifest, pruning["select"]) if pruning is not None else selector,
        needs_state=pruning is None, nodes=_preview_nodes(manifest, candidates, set(changed), pruning),
        tests=tests, pruned=pruning is not None, dbt_only=dbt_only, git_only=git_only, notes=notes,
        lineage_needed=lineage_needed,
    )


async def _launch_spec(project: Project, command: str, select: str | None, extra: tuple[str, ...],
                       record: dict | None, env: dict[str, str]) -> RunResponseDto:
    target = await _load_active_target(project.id)
    args = (("--target", target) if target else ()) + extra
    selector_part = f" --select {select}" if select else ""
    spec = _InvocationSpec(
        command=command, select=select, extra=args,
        cli_command=f"dbt {command}{selector_part}{(' ' + ' '.join(args)) if args else ''}",
        target=target or _profiles_default_target(project),
        profile_name=await _load_active_profile_name(project.id), state_record=record,
    )
    asyncio.create_task(_run_invocation(project, spec, env))
    return RunResponseDto(accepted=True, command=command, select=select)


@router.post("/{project_id}/clone", response_model=RunResponseDto)
async def post_clone(project_id: int, dto: CloneDto, session: AsyncSession = Depends(get_session)) -> RunResponseDto:
    project = await _project(session, project_id)
    env = await load_project_env(project_id)
    try:
        run_state = await resolve_run_state(project, env, "clone", state=True, defer=False, favor_state=False)
    except StateError as exc:
        raise _bad_state(exc) from exc
    extra = run_state.args + (("--full-refresh",) if dto.full_refresh else ())
    return await _launch_spec(project, "clone", dto.select.strip(), extra, run_state.record, env)


def _results_problem(project: Project, inv: RunInvocation) -> str | None:
    """Why target/run_results.json can't be retried from (None: it can)."""
    path = Path(project.path) / "target" / "run_results.json"
    try:
        mtime = path.stat().st_mtime
        args = json.loads(path.read_text(encoding="utf-8")).get("args") or {}
    except (OSError, ValueError):
        return "dbt retry needs target/run_results.json from the last run, and it's missing."
    finished = _as_utc(inv.finished_at)
    if finished is not None and mtime > finished.timestamp() + _RESULTS_SLACK_SECONDS:
        return ("A later dbt command (a preview, compile or show) replaced target/run_results.json, "
                "so dbt retry would retry that instead. Use Rerun.")
    which = args.get("which")
    if which and which not in RETRY_SOURCES:
        return f"The last dbt command was `{which}`, which dbt retry can't resume. Use Rerun."
    return None


@router.post("/{project_id}/runs/retry", response_model=RunResponseDto)
async def post_retry(project_id: int, dto: RetryDto, session: AsyncSession = Depends(get_session)) -> RunResponseDto:
    project = await _project(session, project_id)
    latest = await latest_invocation_id(session, project_id)
    if latest is None or (dto.invocation_id is not None and dto.invocation_id != latest):
        raise HTTPException(status_code=409, detail="dbt retry only works on the last run.")
    inv = await session.get(RunInvocation, latest)
    if inv is None or inv.status == "running":
        raise HTTPException(status_code=409, detail="The last run is still running.")
    problem = _results_problem(project, inv)
    if problem:
        raise HTTPException(status_code=409, detail=problem)
    env = await load_project_env(project_id)
    return await _launch_spec(project, "retry", None, (), None, env)
