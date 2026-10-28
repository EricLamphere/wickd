"""Keep the semantic manifest fresh: a silent, debounced `dbt parse` after YAML edits.

MetricFlow only reads target/semantic_manifest.json, which dbt rewrites on every
command, so YAML edits stay invisible until something runs dbt. When a project has
semantic nodes and MetricFlow isn't off for it, a `.yml`/`.yaml` change schedules a
parse DEBOUNCE_S later (each new change restarts the wait). It's skipped when the
runner is busy: the running command rewrites the manifest anyway. The parse writes
manifest.json, so the watcher's `graph_changed` refreshes the UI.
"""

import asyncio
from collections.abc import Iterable
from pathlib import Path

from app.logging_setup import get_logger

log = get_logger(__name__)

DEBOUNCE_S = 1.5
PARSE_TIMEOUT_S = 180.0
YAML_SUFFIXES = (".yml", ".yaml")

_pending: dict[int, asyncio.TimerHandle] = {}
_running: dict[int, asyncio.Task] = {}


def is_yaml_change(paths: Iterable[str]) -> bool:
    return any(str(p).endswith(YAML_SUFFIXES) for p in paths)


def schedule(project_id: int, project_path: Path, delay: float = DEBOUNCE_S) -> None:
    """(Re)start the debounce timer for this project."""
    from app.semantic.status import forget_spec

    forget_spec(project_path)
    loop = asyncio.get_running_loop()
    existing = _pending.pop(project_id, None)
    if existing is not None:
        existing.cancel()
    _pending[project_id] = loop.call_later(delay, _fire, project_id, project_path)


def _fire(project_id: int, project_path: Path) -> None:
    _pending.pop(project_id, None)
    if project_id in _running and not _running[project_id].done():
        return
    task = asyncio.get_running_loop().create_task(_maybe_parse(project_id, project_path))
    _running[project_id] = task
    task.add_done_callback(lambda _: _running.pop(project_id, None))


async def _should_parse(project_id: int, project_path: Path) -> bool:
    from app.db.engine import SessionLocal
    from app.db.models import Project
    from app.dbt.runner import runner
    from app.semantic.mode import global_mode, resolve
    from app.semantic.service import has_semantic_nodes, manifest_info
    from app.semantic.status import project_spec

    if runner.is_project_busy(project_id):
        return False
    info = await manifest_info(project_path)
    # without semantic nodes, parse anyway for a first semantic model or a latest-spec
    # project dbt hasn't parsed yet
    if not has_semantic_nodes(info) and (
        await asyncio.to_thread(project_spec, project_path, info.manifest_mtime) == "none"
    ):
        return False
    async with SessionLocal() as session:
        project = await session.get(Project, project_id)
        if project is None:
            return False
        return resolve(project.metricflow_mode, await global_mode(session)).mode != "off"


async def _maybe_parse(project_id: int, project_path: Path) -> None:
    from app.api.init import load_project_env
    from app.dbt.runner import RunRequest, runner

    try:
        if not await _should_parse(project_id, project_path):
            return
        env = await load_project_env(project_id)
        target = env.get("DBT_TARGET")
        req = RunRequest(
            project_id=project_id,
            project_path=project_path,
            command="parse",
            extra=("--target", target) if target else (),
            env=env,
        )
        async with asyncio.timeout(PARSE_TIMEOUT_S):
            code, _, stderr = await runner.run(req)
        if code != 0:
            log.info("semantic_autoparse_failed", project_id=project_id, stderr=stderr.decode(errors="replace")[-300:])
    except Exception as exc:  # noqa: BLE001 — a background refresh must never crash the watcher
        log.warning("semantic_autoparse_error", project_id=project_id, error=str(exc))


def cancel_all() -> None:
    for handle in _pending.values():
        handle.cancel()
    _pending.clear()
