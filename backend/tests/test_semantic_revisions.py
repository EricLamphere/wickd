"""semantic/revisions.py: base revisions checked out as worktrees and parsed into wickd's data dir."""

from pathlib import Path

import pytest

from app.config import settings
from app.db.models import Project
from app.dbt.runner import runner
from app.git.runner import git_runner
from app.semantic import revisions
from app.semantic.revisions import RevisionError, side_manifest


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A repo with the dbt project in a subfolder; git and dbt faked, both recorded."""
    root = tmp_path / "repo"
    project = root / "analytics"
    (root / ".git").mkdir(parents=True)
    (root / ".git" / "HEAD").write_text("ref: refs/heads/main")
    (project / "dbt_packages").mkdir(parents=True)
    (project / "profiles.yml").write_text("p: {}")
    (project / "packages.yml").write_text("packages: [a]")
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    calls: dict[str, list] = {"git": [], "dbt": []}

    async def fake_git(req):
        calls["git"].append(req.args)
        if req.args[:2] == ("rev-parse", "--verify"):
            return (0, "abc123def4567890\n") if not req.args[-1].startswith("nope") else (128, "fatal: bad revision")
        if req.args[:2] == ("worktree", "add"):
            tree = Path(req.args[-2])
            (tree / "analytics").mkdir(parents=True)
            (tree / ".git").write_text("gitdir: x")
            (tree / "analytics" / "packages.yml").write_text("packages: [b]")
        return 0, ""

    async def fake_dbt(req):
        calls["dbt"].append(req)
        out = Path(req.extra[req.extra.index("--target-path") + 1])
        out.mkdir(parents=True, exist_ok=True)
        (out / "semantic_manifest.json").write_text("{}")
        return 0, b"", b""

    monkeypatch.setattr(git_runner, "run", fake_git)
    monkeypatch.setattr(runner, "run", fake_dbt)

    async def fake_env(project_id):
        return {"DBT_TARGET": "dev"}

    monkeypatch.setattr(revisions, "load_project_env", fake_env)
    return Project(id=7, name="analytics", path=str(project)), calls


async def test_base_revision_is_a_worktree_parsed_once_per_commit(repo) -> None:
    project, calls = repo
    side = await side_manifest(project, ref="HEAD", target="prod")
    assert side.sha == "abc123def4567890" and side.target == "prod"
    assert side.path.name == "semantic_manifest.json" and side.path.exists()
    assert str(settings.data_dir) in str(side.path)
    add = next(a for a in calls["git"] if a[:2] == ("worktree", "add"))
    assert add[-1] == "abc123def4567890" and "--detach" in add
    parse = calls["dbt"][0]
    assert parse.command == "parse" and parse.project_path.name == "analytics" and parse.extra[-2:] == ("--target", "prod")
    tree = parse.project_path
    assert (tree / "dbt_packages").is_symlink() and (tree / "profiles.yml").is_symlink()
    assert any("packages" in n for n in side.notes)  # packages.yml differs between the revisions

    again = await side_manifest(project, ref="HEAD", target="prod")
    assert again.path == side.path and len(calls["dbt"]) == 1
    assert sum(1 for a in calls["git"] if a[:2] == ("worktree", "add")) == 1


async def test_working_copy_for_another_target_parses_into_the_data_dir(repo) -> None:
    project, calls = repo
    side = await side_manifest(project, ref=None, target="prod")
    assert side.sha is None and calls["dbt"][0].project_path == Path(project.path)
    assert str(settings.data_dir) in calls["dbt"][0].extra[1]
    assert not any(a[:2] == ("worktree", "add") for a in calls["git"])


async def test_the_project_itself_needs_nothing(repo) -> None:
    project, calls = repo
    side = await side_manifest(project, ref=None, target=None)
    assert side.path == Path(project.path) / "target" / "semantic_manifest.json"
    assert not calls["git"] and not calls["dbt"]


async def test_bad_refs_and_failed_parses_are_errors(repo, monkeypatch) -> None:
    project, _ = repo
    with pytest.raises(RevisionError) as bad:
        await side_manifest(project, ref="nope", target=None)
    assert bad.value.code == "unknown_ref"

    async def failing(req):
        return 1, b"Encountered an error:\nParsing Error in metric", b""

    monkeypatch.setattr(runner, "run", failing)
    with pytest.raises(RevisionError) as failed:
        await side_manifest(project, ref=None, target="prod")
    assert failed.value.code == "parse_failed" and "Parsing Error" in failed.value.message


async def test_old_worktrees_are_removed(repo, monkeypatch) -> None:
    project, calls = repo
    base = settings.data_dir / "compare" / "7"
    for i, name in enumerate(["old1", "old2", "old3", "old4"]):
        (base / name).mkdir(parents=True)
        (base / name / ".git").write_text("gitdir: x")
        import os
        os.utime(base / name, (i, i))
    await side_manifest(project, ref="HEAD", target=None)
    removed = [a[-1] for a in calls["git"] if a[:2] == ("worktree", "remove")]
    assert sorted(Path(r).name for r in removed) == ["old1", "old2"]  # the 3 newest stay, this one included
