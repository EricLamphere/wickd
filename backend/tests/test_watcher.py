import asyncio
from pathlib import Path

import pytest
from watchfiles import Change

from app.events.bus import bus
from app.watcher import service
from app.watcher.service import (
    WatcherManager,
    build_plan,
    collapse_roots,
    is_relevant,
    route_changes,
)


def _repo_with_projects(tmp_path: Path, *names: str) -> tuple[Path, list[Path]]:
    repo = tmp_path.resolve() / "repo"
    (repo / ".git" / "refs" / "heads").mkdir(parents=True)
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    projects = []
    for name in names:
        p = repo / "projects" / name
        (p / "models").mkdir(parents=True)
        projects.append(p)
    return repo, projects


def test_collapse_roots_dedupes_and_drops_nested(tmp_path: Path) -> None:
    a, b = tmp_path / "a", tmp_path / "b"
    assert collapse_roots([a / "x", a, b, a, b / "y" / "z"]) == (a, b)


def test_build_plan_watches_shared_git_dir_once(tmp_path: Path) -> None:
    repo, (p1, p2) = _repo_with_projects(tmp_path, "one", "two")
    plan = build_plan([(1, p1), (2, p2), (3, tmp_path / "missing")])

    assert [wp.project_id for wp in plan.projects] == [1, 2]
    assert all(wp.git_dir == repo / ".git" for wp in plan.projects)
    assert plan.roots == (repo / ".git", p1, p2)


def test_is_relevant_filters_noise(tmp_path: Path) -> None:
    repo, (p1,) = _repo_with_projects(tmp_path, "one")
    plan = build_plan([(1, p1)])
    git = repo / ".git"

    assert is_relevant(plan, p1 / "models" / "a.sql")
    assert is_relevant(plan, p1 / "target" / "manifest.json")
    assert is_relevant(plan, git / "HEAD")
    assert is_relevant(plan, git / "refs" / "heads" / "main")
    assert not is_relevant(plan, git / "objects" / "ab" / "cdef")
    assert not is_relevant(plan, p1 / "logs" / "dbt.log")
    assert not is_relevant(plan, p1 / "dbt_packages" / "pkg" / "models" / "x.sql")
    assert not is_relevant(plan, tmp_path / "elsewhere.sql")


def test_route_changes_fans_git_changes_out_to_repo_projects(tmp_path: Path) -> None:
    repo, (p1, p2) = _repo_with_projects(tmp_path, "one", "two")
    plan = build_plan([(1, p1), (2, p2)])
    model = (Change.modified, str(p1 / "models" / "a.sql"))
    head = (Change.modified, str(repo / ".git" / "HEAD"))

    assert route_changes(plan, {model, head}) == {1: {model, head}, 2: {head}}


@pytest.mark.parametrize("change_kind", ["model", "git"])
async def test_manager_publishes_events_from_real_file_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change_kind: str
) -> None:
    repo, (p1, p2) = _repo_with_projects(tmp_path, "one", "two")
    rows = [(1, p1), (2, p2)]

    manager = WatcherManager()

    async def fake_sync() -> None:
        plan = build_plan(rows)
        manager._plan = plan
        stop = service.threading.Event()
        manager._thread_stop = stop
        service.threading.Thread(
            target=manager._watch_thread, args=(plan, stop, asyncio.get_running_loop()), daemon=True
        ).start()

    monkeypatch.setattr(manager, "_sync_watchers", fake_sync)
    monkeypatch.setattr(manager, "_mark_stale_by_path", lambda *_a: asyncio.sleep(0))

    topic = "project:2" if change_kind == "git" else "project:1"
    expected = "git_status_changed" if change_kind == "git" else "files_changed"
    queue = await bus.subscribe(topic)
    try:
        await manager.start()
        await asyncio.sleep(0.5)  # let the OS watcher arm
        if change_kind == "git":
            (repo / ".git" / "HEAD").write_text("ref: refs/heads/other\n")
        else:
            (p1 / "models" / "a.sql").write_text("select 1")
        async def next_of_type() -> str:
            # FSEvents may also report the fixture's own writes; skip unrelated events.
            while (event := await queue.get()).type != expected:
                pass
            return event.type

        assert await asyncio.wait_for(next_of_type(), timeout=5.0) == expected
    finally:
        await manager.stop()
        await bus.unsubscribe(topic, queue)
