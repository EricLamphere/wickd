import asyncio
import json
import shlex
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.env import _read_profiles_yml
from app.api.init import load_project_env
from app.api.run_history import (  # noqa: F401 — re-exported (api/slim.py imports them from here)
    _as_utc,
    _state_record,
    latest_invocation_id,
)
from app.db.engine import SessionLocal, get_session
from app.db.models import (
    GlobalProfile,
    InvocationModelResult,
    ModelStatus,
    Project,
    ProjectEnvVar,
    RunInvocation,
)
from app.dbt.custom_command import CustomCommandError, ParsedCommand, parse_custom_command
from app.dbt.manifest import load_manifest
from app.dbt.run_results import load_run_results, load_run_results_file
from app.dbt.runner import RunRequest, runner
from app.dbt.select import SelectMode, build_selector
from app.dbt.state import RunState, StateError, resolve_run_state
from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import monitors

log = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["runs"])

_MAX_HISTORY_PER_NODE = 20  # rows kept in invocation_model_results per (project, unique_id)
_MAX_CUSTOM_COMMAND_LENGTH = 4096


class RunRequestDto(BaseModel):
    model: str | None = None
    mode: SelectMode = "only"
    select: str | None = None  # explicit pass-through if provided
    full_refresh: bool = False
    threads: int | None = None
    debug: bool = False
    empty: bool = False
    vars: dict[str, str] | None = None
    # slim builds (plan 18): `state` adds --state (for state: selectors); defer / favor_state
    # None = the project's sticky "Defer to prod" choice
    state: bool = False
    defer: bool | None = None
    favor_state: bool | None = None


class CustomCommandDto(BaseModel):
    command: str = Field(max_length=_MAX_CUSTOM_COMMAND_LENGTH)


class RunResponseDto(BaseModel):
    accepted: bool
    command: str
    select: str | None


def _resolve_selector(dto: RunRequestDto) -> str | None:
    if dto.select:
        return dto.select
    if dto.model:
        return build_selector(dto.model, dto.mode)
    return None


def _invocation_log_path(project_path: Path, invocation_id: int) -> Path:
    log_dir = project_path / "logs" / "wickd" / "invocations"
    log_dir.mkdir(parents=True, exist_ok=True)
    gitignore = project_path / "logs" / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("*\n", encoding="utf-8")
    return log_dir / f"{invocation_id}.log"


async def _trim_node_history(session: AsyncSession, project_id: int, unique_id: str) -> None:
    """Keep only the most recent _MAX_HISTORY_PER_NODE rows for this node."""
    result = await session.execute(
        select(InvocationModelResult.id)
        .where(
            InvocationModelResult.project_id == project_id,
            InvocationModelResult.unique_id == unique_id,
        )
        .order_by(InvocationModelResult.id.desc())
        .offset(_MAX_HISTORY_PER_NODE)
    )
    old_ids = [row[0] for row in result.fetchall()]
    if old_ids:
        await session.execute(
            delete(InvocationModelResult).where(InvocationModelResult.id.in_(old_ids))
        )


def result_kind(unique_id: str) -> str:
    """model_statuses / run history kind of a run_results entry: test, unit_test or model."""
    if unique_id.startswith("test."):
        return "test"
    if unique_id.startswith("unit_test."):
        return "unit_test"
    return "model"


async def _persist_results_after_run(project: Project, invocation_id: int | None = None) -> None:
    run_file = load_run_results_file(Path(project.path) / "target" / "run_results.json")
    results = run_file.results
    if not results:
        return
    manifest = load_manifest(Path(project.path) / "target" / "manifest.json")
    parent_model_by_test: dict[str, str | None] = {}
    if manifest is not None:
        parent_map = {child: tuple(parents) for child, parents in manifest.parents.items()}
        for node in manifest.nodes:
            if node.resource_type == "test":
                parents = parent_map.get(node.unique_id, ())
                model_parent = next(
                    (p for p in parents if p.startswith(("model.", "snapshot.", "seed."))),
                    None,
                )
                parent_model_by_test[node.unique_id] = model_parent
        for unit in manifest.unit_tests:
            parent_model_by_test[unit.unique_id] = unit.model_unique_id

    async with SessionLocal() as session:
        # Update model_statuses (current snapshot — unchanged behaviour)
        existing = await session.execute(
            select(ModelStatus).where(ModelStatus.project_id == project.id)
        )
        by_uid = {row.unique_id: row for row in existing.scalars().all()}
        now = datetime.now(UTC)
        for r in results:
            row = by_uid.get(r.unique_id)
            kind = result_kind(r.unique_id)
            if row is None:
                row = ModelStatus(
                    project_id=project.id,
                    unique_id=r.unique_id,
                    kind=kind,
                    parent_model_id=parent_model_by_test.get(r.unique_id),
                )
                session.add(row)
            # rows written before unit tests had their own kind (stored as parentless models)
            row.kind = kind
            if kind != "model" and parent_model_by_test.get(r.unique_id):
                row.parent_model_id = parent_model_by_test[r.unique_id]
            row.status = r.status
            row.message = r.message
            row.execution_time = r.execution_time
            row.invocation_id = invocation_id
            row.finished_at = now
        await session.commit()

        # Write to history table and trim to _MAX_HISTORY_PER_NODE per node
        if invocation_id is not None:
            for r in results:
                kind = result_kind(r.unique_id)
                parts = r.unique_id.split(".")
                # test unique IDs: test.<project>.<test_name>.<hash> — use index 2
                # model / unit test unique IDs: <type>.<project>[.<model>].<name> — use last segment
                name = parts[2] if kind == "test" and len(parts) >= 4 else parts[-1]
                session.add(InvocationModelResult(
                    invocation_id=invocation_id,
                    project_id=project.id,
                    unique_id=r.unique_id,
                    name=name,
                    kind=kind,
                    status=r.status,
                    execution_time=r.execution_time,
                    message=r.message,
                    started_at=r.started_at,
                    completed_at=r.completed_at,
                    thread_id=r.thread_id,
                    rows_affected=r.rows_affected,
                    bytes_processed=r.bytes_processed,
                    adapter_response_json=json.dumps(r.adapter_response) if r.adapter_response else None,
                ))
            inv_row = await session.get(RunInvocation, invocation_id)
            if inv_row is not None:
                inv_row.threads = run_file.threads
                inv_row.elapsed_time = run_file.elapsed_time
            await session.commit()
            unique_ids = {r.unique_id for r in results}
            for uid in unique_ids:
                await _trim_node_history(session, project.id, uid)
            await session.commit()

    await bus.publish(
        Event(topic=f"project:{project.id}", type="statuses_changed", data={})
    )
    # Metric monitors downstream of what this run built (Pro; no-op without monitors)
    monitors.schedule_after_run(
        project.id, Path(project.path), {r.unique_id for r in results if r.status == "success"}
    )

    for r in results:
        if result_kind(r.unique_id) in ("test", "unit_test") and r.status in ("fail", "error"):
            model_uid = parent_model_by_test.get(r.unique_id)
            await bus.publish(
                Event(
                    topic=f"project:{project.id}",
                    type="test_failed",
                    data={
                        "test_uid": r.unique_id,
                        "model_uid": model_uid,
                        "message": r.message,
                    },
                )
            )


async def _load_active_target(project_id: int) -> str | None:
    async with SessionLocal() as session:
        result = await session.execute(
            sa_select(ProjectEnvVar).where(
                ProjectEnvVar.project_id == project_id,
                ProjectEnvVar.key == "dbt_target",
            )
        )
        row = result.scalar_one_or_none()
        return row.value if row else None


async def _load_active_profile_name(project_id: int) -> str | None:
    async with SessionLocal() as session:
        id_row = await session.execute(
            sa_select(ProjectEnvVar).where(
                ProjectEnvVar.project_id == project_id,
                ProjectEnvVar.key == "active_global_profile_id",
            )
        )
        id_var = id_row.scalar_one_or_none()
        if id_var is None:
            return None
        try:
            gp = await session.get(GlobalProfile, int(id_var.value))
            return gp.name if gp else None
        except (ValueError, TypeError):
            return None


@dataclass(frozen=True)
class _InvocationSpec:
    """Everything needed to execute one dbt invocation and record it in run history."""
    command: str
    select: str | None
    extra: tuple[str, ...]
    cli_command: str
    target: str | None
    profile_name: str | None
    inject_profiles_dir: bool = True
    custom_args: tuple[str, ...] | None = None
    state_record: dict | None = None
    trigger: str = "manual"  # manual | schedule | rerun
    schedule_id: int | None = None


def _profiles_default_target(project: Project) -> str | None:
    profiles = _read_profiles_yml(Path(project.path))
    profile_data = profiles.get(project.profile or project.name, {})
    return profile_data.get("target") or None


def _run_results_mtime(project_path: Path) -> float | None:
    try:
        return (project_path / "target" / "run_results.json").stat().st_mtime
    except OSError:
        return None


async def _create_invocation(project: Project, spec: _InvocationSpec) -> tuple[int, Path]:
    async with SessionLocal() as session:
        inv = RunInvocation(
            project_id=project.id,
            command=spec.command,
            selector=spec.select,
            cli_command=spec.cli_command,
            profile=spec.profile_name,
            target=spec.target,
            status="running",
            started_at=datetime.now(UTC),
            custom_args=json.dumps(list(spec.custom_args)) if spec.custom_args is not None else None,
            state_json=json.dumps(spec.state_record) if spec.state_record is not None else None,
            trigger=spec.trigger,
            schedule_id=spec.schedule_id,
        )
        session.add(inv)
        await session.commit()
        await session.refresh(inv)
        log_path = _invocation_log_path(Path(project.path), inv.id)
        inv.log_path = str(log_path)
        await session.commit()
        return inv.id, log_path


def _invocation_status(
    cancelled: bool, run_error: bool, results_fresh: bool, return_code: int | None, project_path: Path
) -> str:
    if cancelled:
        return "cancelled"
    if run_error:
        return "error"
    if results_fresh:
        results = load_run_results(project_path / "target" / "run_results.json")
        return "error" if any(r.status == "error" for r in results) else "success"
    # Commands like ls/parse/debug don't write run_results.json — trust the exit code.
    return "success" if return_code == 0 else "error"


async def _finalize_invocation(project: Project, invocation_id: int, status: str) -> None:
    try:
        async with SessionLocal() as session:
            inv_row = await session.get(RunInvocation, invocation_id)
            if inv_row is not None:
                inv_row.status = status
                inv_row.finished_at = datetime.now(UTC)
                await session.commit()
    except Exception:
        log.exception("invocation_status_update_failed", project_id=project.id, invocation_id=invocation_id)
    await bus.publish(Event(
        topic=f"project:{project.id}",
        type="run_history_changed",
        data={"invocation_id": invocation_id},
    ))


OnStart = Callable[[int], Awaitable[None]]


async def _run_invocation(
    project: Project, spec: _InvocationSpec, env: dict[str, str], on_start: OnStart | None = None,
) -> tuple[int, str]:
    """Record a RunInvocation, stream dbt through the runner, then persist results and status.
    Returns (invocation id, final status); `on_start` gets the id once the row exists."""
    project_path = Path(project.path)
    invocation_id, log_path = await _create_invocation(project, spec)
    if on_start is not None:
        await on_start(invocation_id)
    req = RunRequest(
        project_id=project.id,
        project_path=project_path,
        command=spec.command,
        select=spec.select if spec.custom_args is None else None,
        extra=spec.extra,
        env=env,
        inject_profiles_dir=spec.inject_profiles_dir,
        trigger=spec.trigger,
        schedule_id=spec.schedule_id,
        invocation_id=invocation_id,
    )
    results_mtime_before = _run_results_mtime(project_path)
    run_error = False
    try:
        with log_path.open("a", encoding="utf-8") as lf:
            async for _kind, line in runner.stream(req):
                lf.write(line + "\n")
    except Exception:
        log.exception("dbt_invocation_failed", project_id=project.id, invocation_id=invocation_id)
        run_error = True
    finally:
        return_code = runner.pop_return_code(project.id)
        cancelled = runner.pop_cancel_flag(project.id)
        results_mtime_after = _run_results_mtime(project_path)
        # Only persist run_results.json if this invocation rewrote it; otherwise
        # we would re-record a previous run's results as this one's.
        results_fresh = results_mtime_after is not None and results_mtime_after != results_mtime_before
        if results_fresh:
            try:
                await _persist_results_after_run(project, invocation_id)
            except Exception:
                log.exception("persist_results_failed", project_id=project.id, invocation_id=invocation_id)
        status = _invocation_status(cancelled, run_error, results_fresh, return_code, project_path)
        await _finalize_invocation(project, invocation_id, status)
    return invocation_id, status


async def _run_dbt_and_persist(
    project: Project,
    command: str,
    select: str | None,
    full_refresh: bool = False,
    threads: int | None = None,
    debug: bool = False,
    empty: bool = False,
    vars: dict[str, str] | None = None,
    run_state: RunState | None = None,
    trigger: str = "manual",
) -> None:
    env = await load_project_env(project.id)
    active_target = await _load_active_target(project.id)
    profile_name = await _load_active_profile_name(project.id)
    extra: tuple[str, ...] = ("--target", active_target) if active_target else ()
    if full_refresh:
        extra += ("--full-refresh",)
    if threads is not None:
        extra += ("--threads", str(threads))
    if debug:
        extra += ("--debug",)
    if empty:
        extra += ("--empty",)
    if vars:
        extra += ("--vars", json.dumps(vars))
    if run_state is not None:
        extra += run_state.args

    selector_part = f" --select {select}" if select else ""
    extra_part = (" " + " ".join(extra)) if extra else ""
    spec = _InvocationSpec(
        command=command,
        select=select,
        extra=extra,
        cli_command=f"dbt {command}{selector_part}{extra_part}",
        target=active_target or _profiles_default_target(project),
        profile_name=profile_name,
        state_record=run_state.record if run_state is not None else None,
        trigger=trigger,
    )
    await _run_invocation(project, spec, env)


async def _run_custom_and_persist(
    project: Project,
    parsed: ParsedCommand,
    *,
    target: str | None = None,
    trigger: str = "manual",
    schedule_id: int | None = None,
    on_start: OnStart | None = None,
) -> tuple[int, str]:
    """Run a user-entered dbt command. The command's own --target wins, then `target`
    (a schedule's pinned one), then the active target."""
    env = await load_project_env(project.id)
    profile_name = await _load_active_profile_name(project.id)
    extra = parsed.rest
    if parsed.has_target:
        target = parsed.target
    else:
        chosen = target or await _load_active_target(project.id)
        if chosen:
            extra += ("--target", chosen)
        target = chosen or _profiles_default_target(project)
    spec = _InvocationSpec(
        command=parsed.subcommand,
        select=parsed.selector,
        extra=extra,
        cli_command="dbt " + shlex.join((parsed.subcommand, *extra)),
        target=target,
        profile_name=profile_name,
        inject_profiles_dir=not parsed.has_profiles_dir,
        custom_args=parsed.args,
        trigger=trigger,
        schedule_id=schedule_id,
    )
    return await _run_invocation(project, spec, env, on_start)


async def _launch(
    project: Project, command: str, dto: RunRequestDto, trigger: str = "manual",
) -> RunResponseDto:
    select = _resolve_selector(dto)
    env = await load_project_env(project.id)
    try:
        run_state = await resolve_run_state(
            project, env, command, state=dto.state, defer=dto.defer, favor_state=dto.favor_state,
        )
    except StateError as exc:
        raise HTTPException(status_code=400, detail={"error": exc.code, "message": exc.message}) from exc
    asyncio.create_task(
        _run_dbt_and_persist(
            project, command, select,
            dto.full_refresh, dto.threads, dto.debug, dto.empty, dto.vars, run_state, trigger=trigger,
        )
    )
    return RunResponseDto(accepted=True, command=command, select=select)


def _launch_custom(project: Project, parsed: ParsedCommand, trigger: str = "manual") -> RunResponseDto:
    asyncio.create_task(_run_custom_and_persist(project, parsed, trigger=trigger))
    return RunResponseDto(accepted=True, command=parsed.subcommand, select=parsed.selector)


@router.post("/{project_id}/run", response_model=RunResponseDto)
async def post_run(
    project_id: int,
    dto: RunRequestDto,
    session: AsyncSession = Depends(get_session),
) -> RunResponseDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return await _launch(project, "run", dto)


@router.post("/{project_id}/build", response_model=RunResponseDto)
async def post_build(
    project_id: int,
    dto: RunRequestDto,
    session: AsyncSession = Depends(get_session),
) -> RunResponseDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return await _launch(project, "build", dto)


@router.post("/{project_id}/seed", response_model=RunResponseDto)
async def post_seed(
    project_id: int,
    dto: RunRequestDto,
    session: AsyncSession = Depends(get_session),
) -> RunResponseDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return await _launch(project, "seed", dto)


@router.post("/{project_id}/test", response_model=RunResponseDto)
async def post_test(
    project_id: int,
    dto: RunRequestDto,
    session: AsyncSession = Depends(get_session),
) -> RunResponseDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return await _launch(project, "test", dto)


@router.post("/{project_id}/command", response_model=RunResponseDto)
async def post_custom_command(
    project_id: int,
    dto: CustomCommandDto,
    session: AsyncSession = Depends(get_session),
) -> RunResponseDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        parsed = parse_custom_command(dto.command)
    except CustomCommandError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _launch_custom(project, parsed)


@router.post("/{project_id}/runs/cancel")
async def post_cancel_run(
    project_id: int,
    session: AsyncSession = Depends(get_session),
) -> dict:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    killed = runner.cancel(project_id)
    return {"cancelled": killed}


@router.post("/{project_id}/run-history/{invocation_id}/rerun", response_model=RunResponseDto)
async def post_rerun_invocation(
    project_id: int,
    invocation_id: int,
    session: AsyncSession = Depends(get_session),
) -> RunResponseDto:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    inv = await session.get(RunInvocation, invocation_id)
    if inv is None or inv.project_id != project_id:
        raise HTTPException(status_code=404, detail="invocation not found")
    if inv.custom_args is not None:
        try:
            parsed = ParsedCommand.from_args(json.loads(inv.custom_args))
        except (CustomCommandError, json.JSONDecodeError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=f"cannot rerun this command: {exc}") from exc
        return _launch_custom(project, parsed, "rerun")
    record = _state_record(inv) or {}
    dto = RunRequestDto(
        select=inv.selector, state=bool(record.get("state")),
        defer=bool(record.get("defer")), favor_state=bool(record.get("favor_state")),
    )
    return await _launch(project, inv.command, dto, "rerun")
