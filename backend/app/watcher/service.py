"""File watching for every project through ONE shared watcher.

A watcher per project made startup crawl with many projects: watchfiles'
`awatch()` builds its Rust watcher synchronously on the event loop (so each
project's setup blocked the next) and parks a worker thread per project, and
projects in the same repo each watched that repo's whole `.git` dir. Instead,
one `watchfiles.watch()` runs on a dedicated thread over the deduplicated roots
(project dirs + their `.git` dirs) and batches are routed back to projects by
path on the event loop.
"""

import asyncio
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from watchfiles import Change, watch

from app.db.engine import SessionLocal
from app.db.models import ModelStatus, Project
from app.events.bus import Event, bus
from app.git.repo import find_repo_root
from app.logging_setup import get_logger

log = get_logger(__name__)

WATCHED_SUBDIRS = ("models", "tests", "seeds", "snapshots", "macros", "analyses")

# .git paths whose changes indicate branch/index state flipped
_GIT_STATUS_FILES = {"HEAD", "index", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD"}

# Noisy dirs inside a project that never matter (dbt logs, installed packages,
# Python envs, ...). Dropped before batches reach the event loop.
_IGNORED_PROJECT_DIRS = {
    "logs", "dbt_packages", "node_modules", "__pycache__", "site-packages", ".venv", "venv",
}

_RESYNC_SECONDS = 10.0
_DEBOUNCE_MS = 200

Changes = set[tuple[Change, str]]


@dataclass(frozen=True)
class WatchedProject:
    project_id: int
    path: Path
    git_dir: Path | None


@dataclass(frozen=True)
class WatchPlan:
    projects: tuple[WatchedProject, ...]
    roots: tuple[Path, ...]


def _is_under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def collapse_roots(paths: list[Path]) -> tuple[Path, ...]:
    """Dedupe and drop any path nested inside another — a recursive watch covers it."""
    unique = sorted(set(paths), key=lambda p: len(p.parts))
    kept: list[Path] = []
    for p in unique:
        if not any(_is_under(p, k) for k in kept):
            kept.append(p)
    return tuple(sorted(kept))


def build_plan(projects: list[tuple[int, Path]]) -> WatchPlan:
    """Resolve each existing project's git dir and the minimal set of roots to watch."""
    watched: list[WatchedProject] = []
    for project_id, path in projects:
        if not path.is_dir():
            continue
        repo_root = find_repo_root(path)
        git_dir = repo_root / ".git" if repo_root is not None else None
        if git_dir is not None and not git_dir.is_dir():
            git_dir = None  # worktree/submodule .git file — nothing to watch
        watched.append(WatchedProject(project_id, path, git_dir))
    roots = [w.path for w in watched] + [w.git_dir for w in watched if w.git_dir is not None]
    return WatchPlan(projects=tuple(watched), roots=collapse_roots(roots))


def is_relevant(plan: WatchPlan, path: Path) -> bool:
    """Cheap pre-filter run on the watcher thread for every raw change."""
    for wp in plan.projects:
        if wp.git_dir is not None and _is_under(path, wp.git_dir):
            rel = path.relative_to(wp.git_dir).parts
            return bool(rel) and (rel[0] in _GIT_STATUS_FILES or rel[0] == "refs")
    for wp in plan.projects:
        if _is_under(path, wp.path):
            rel = path.relative_to(wp.path).parts
            if not any(part in _IGNORED_PROJECT_DIRS for part in rel):
                return True
    return False


def route_changes(plan: WatchPlan, changes: Changes) -> dict[int, Changes]:
    """Split one batch into per-project batches (a .git change goes to every project in that repo)."""
    routed: dict[int, Changes] = {}
    for change in changes:
        path = Path(change[1])
        for wp in plan.projects:
            in_project = _is_under(path, wp.path)
            in_git = wp.git_dir is not None and _is_under(path, wp.git_dir)
            if in_project or in_git:
                routed.setdefault(wp.project_id, set()).add(change)
    return routed


class WatcherManager:
    def __init__(self) -> None:
        self._plan = WatchPlan(projects=(), roots=())
        self._thread_stop: threading.Event | None = None
        self._queue: asyncio.Queue[tuple[WatchPlan, Changes]] | None = None
        self._tasks: list[asyncio.Task] = []
        self._stop = asyncio.Event()
        self._sync_lock = asyncio.Lock()

    async def resync(self) -> None:
        """Re-read the project list now (e.g. right after a rescan) instead of waiting for the next tick."""
        try:
            await self._sync_watchers()
        except Exception as exc:  # noqa: BLE001 — error is logged/reported below
            log.warning("watcher_sync_error", error=str(exc))

    async def start(self) -> None:
        self._stop.clear()
        self._queue = asyncio.Queue()
        self._tasks = [
            asyncio.create_task(self._supervisor_loop()),
            asyncio.create_task(self._dispatch_loop()),
        ]

    async def stop(self) -> None:
        self._stop.set()
        self._stop_thread()
        for task in self._tasks:
            task.cancel()
        self._tasks = []

    def _stop_thread(self) -> None:
        if self._thread_stop is not None:
            self._thread_stop.set()
            self._thread_stop = None

    async def _supervisor_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._sync_watchers()
            except Exception as exc:  # noqa: BLE001 — error is logged/reported below
                log.warning("watcher_sync_error", error=str(exc))
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=_RESYNC_SECONDS)
            except TimeoutError:
                pass

    async def _sync_watchers(self) -> None:
        async with self._sync_lock:
            await self._sync_watchers_locked()

    async def _sync_watchers_locked(self) -> None:
        async with SessionLocal() as session:
            result = await session.execute(select(Project.id, Project.path))
            rows = [(pid, Path(path)) for pid, path in result.all()]
        started = time.perf_counter()
        plan = await asyncio.to_thread(build_plan, rows)
        plan_ms = round((time.perf_counter() - started) * 1000)
        if plan == self._plan:
            return
        self._stop_thread()
        self._plan = plan
        if not plan.roots:
            return
        stop = threading.Event()
        self._thread_stop = stop
        loop = asyncio.get_running_loop()
        threading.Thread(
            target=self._watch_thread, args=(plan, stop, loop), name="wickd-watcher", daemon=True
        ).start()
        log.info(
            "watcher_start",
            projects=len(plan.projects),
            roots=len(plan.roots),
            plan_ms=plan_ms,
        )

    def _watch_thread(
        self, plan: WatchPlan, stop: threading.Event, loop: asyncio.AbstractEventLoop
    ) -> None:
        queue = self._queue
        if queue is None:
            return
        try:
            for changes in watch(
                *plan.roots,
                watch_filter=lambda _c, p: is_relevant(plan, Path(p)),
                stop_event=stop,
                debounce=_DEBOUNCE_MS,
                recursive=True,
                ignore_permission_denied=True,
                raise_interrupt=False,
            ):
                loop.call_soon_threadsafe(queue.put_nowait, (plan, changes))
        except Exception as exc:  # noqa: BLE001 — error is logged/reported below
            log.warning("watcher_error", error=str(exc))

    async def _dispatch_loop(self) -> None:
        if self._queue is None:
            return
        while True:
            plan, changes = await self._queue.get()
            if plan != self._plan:
                continue  # batch from a watcher that has since been replaced
            by_id = {wp.project_id: wp for wp in plan.projects}
            for project_id, project_changes in route_changes(plan, changes).items():
                wp = by_id[project_id]
                try:
                    await self._handle_changes(
                        project_id, wp.path, wp.git_dir, f"project:{project_id}", project_changes
                    )
                except Exception as exc:  # noqa: BLE001 — error is logged/reported below
                    log.warning("watcher_dispatch_error", project_id=project_id, error=str(exc))

    async def _handle_changes(
        self,
        project_id: int,
        project_path: Path,
        git_dir: Path | None,
        topic: str,
        changes: set[tuple[Change, str]],
    ) -> None:
        changed_files = [Path(p) for _, p in changes]

        # Git index/branch changes
        if git_dir is not None:
            for f in changed_files:
                try:
                    rel = f.relative_to(git_dir)
                except ValueError:
                    continue
                parts = rel.parts
                if not parts:
                    continue
                # HEAD, index, ORIG_HEAD, FETCH_HEAD, or anything under refs/
                if parts[0] in _GIT_STATUS_FILES or parts[0] == "refs":
                    await bus.publish(Event(topic=topic, type="git_status_changed", data={}))
                    break

        if any(str(p).endswith("manifest.json") for p in changed_files):
            await bus.publish(Event(topic=topic, type="graph_changed", data={}))

        stale_model_paths: list[str] = []
        for f in changed_files:
            try:
                rel = f.relative_to(project_path)
            except ValueError:
                continue
            parts = rel.parts
            if not parts:
                continue
            if parts[0] in WATCHED_SUBDIRS and f.suffix in {".sql", ".yml", ".yaml"}:
                stale_model_paths.append(str(rel))

        if stale_model_paths:
            await self._mark_stale_by_path(project_id, stale_model_paths)
            await bus.publish(
                Event(
                    topic=topic,
                    type="files_changed",
                    data={"paths": stale_model_paths},
                )
            )

    async def _mark_stale_by_path(self, project_id: int, paths: list[str]) -> None:
        async with SessionLocal() as session:
            result = await session.execute(
                select(ModelStatus).where(ModelStatus.project_id == project_id)
            )
            rows = list(result.scalars().all())
            for row in rows:
                pass
            await session.commit()
        # Path→unique_id mapping requires a manifest lookup done in the models API;
        # here we emit an event only. Status reset is handled by the /models endpoint
        # during the next fetch after a run, which is the authoritative refresh point.


watcher_manager = WatcherManager()
