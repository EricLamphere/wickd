"""The semantic manifests compare mode (plan 14) explains a query against.

- A **base revision** (HEAD, a branch's base) is checked out as a git worktree in
  `<data_dir>/compare/<project_id>/<sha12>/`, never inside the user's repo, and reused per
  commit; the 3 most recently used are kept per project, older ones removed. What isn't in git
  is linked in from the working copy: `dbt_packages/` (same packages assumed — a note says so
  when packages.yml / dependencies.yml differ) and an untracked `profiles.yml`.
- **Another target** (DIFF_BASE_TARGET, e.g. prod): the same project parsed with `--target`, so
  the SQL MetricFlow writes reads that target's relations.

Every parse is `dbt parse --target-path <data_dir>/compare/<project_id>/targets/<…>` through
the runner (no warehouse connection), so nothing is written into the project. A worktree is
parsed once per commit and target; the working copy is re-parsed each time (it changes).
"""

import asyncio
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from app.api.init import load_project_env
from app.config import settings
from app.db.models import Project
from app.dbt.runner import RunRequest, runner
from app.git.repo import find_repo_root
from app.git.runner import GitRequest, git_runner
from app.logging_setup import get_logger
from app.semantic import service

log = get_logger(__name__)

KEEP_WORKTREES = 3
TARGETS_DIR = "targets"
# not in git, but needed to parse a checkout
LINKED = ("dbt_packages", "profiles.yml")
PACKAGE_FILES = ("packages.yml", "dependencies.yml")

_locks: dict[int, asyncio.Lock] = {}


class RevisionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class SideManifest:
    path: Path
    # the commit checked out (None: the working copy)
    sha: str | None
    # the target parsed for (None: the active one)
    target: str | None
    notes: tuple[str, ...] = field(default_factory=tuple)


def compare_dir(project_id: int) -> Path:
    return settings.data_dir / "compare" / str(project_id)


def _lock(project_id: int) -> asyncio.Lock:
    return _locks.setdefault(project_id, asyncio.Lock())


async def _git(project_id: int, repo: Path, *args: str) -> tuple[int, str]:
    return await git_runner.run(GitRequest(project_id=project_id, repo_root=repo, args=args))


async def _resolve(project_id: int, repo: Path, ref: str) -> str:
    rc, out = await _git(project_id, repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
    sha = out.strip().splitlines()[-1] if out.strip() else ""
    if rc != 0 or not sha:
        raise RevisionError("unknown_ref", f"`{ref}` isn't a commit or branch in this repository.")
    return sha


def _link_untracked(source: Path, tree: Path) -> list[str]:
    """Link what git doesn't carry into the checkout; notes about what may differ."""
    for name in LINKED:
        src, dest = source / name, tree / name
        if src.exists() and not dest.exists() and not dest.is_symlink():
            dest.symlink_to(src, target_is_directory=src.is_dir())
    differs = [n for n in PACKAGE_FILES if _read(source / n) != _read(tree / n)]
    if differs:
        return [(f"{', '.join(differs)} differs between the two revisions; the earlier one is parsed with the "
                 "packages installed now, which can change its numbers.")]
    return []


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


async def _checkout(project: Project, ref: str) -> tuple[Path, str, list[str]]:
    """(the project folder inside a worktree of `ref`, its sha, notes)."""
    project_path = Path(project.path)
    repo = find_repo_root(project_path)
    if repo is None:
        raise RevisionError("not_a_repo", "This project isn't in a git repository, so there's no earlier revision to compare with.")
    sha = await _resolve(project.id, repo, ref)
    tree = compare_dir(project.id) / sha[:12]
    if not (tree / ".git").exists():
        if tree.exists():
            shutil.rmtree(tree, ignore_errors=True)
        await _git(project.id, repo, "worktree", "prune")
        tree.parent.mkdir(parents=True, exist_ok=True)
        rc, out = await _git(project.id, repo, "worktree", "add", "--detach", "--force", str(tree), sha)
        if rc != 0:
            raise RevisionError("checkout_failed", out.strip()[-800:] or f"Couldn't check out {ref}.")
        log.info("compare_worktree_added", project_id=project.id, sha=sha[:12])
    os.utime(tree)  # most recently used
    await _trim(project.id, repo)
    inside = tree / project_path.resolve().relative_to(repo.resolve())
    return inside, sha, _link_untracked(project_path, inside)


async def _trim(project_id: int, repo: Path) -> None:
    trees = [p for p in compare_dir(project_id).iterdir() if p.is_dir() and p.name != TARGETS_DIR]
    trees.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for old in trees[KEEP_WORKTREES:]:
        await _git(project_id, repo, "worktree", "remove", "--force", str(old))
        shutil.rmtree(old, ignore_errors=True)
        for parsed in (compare_dir(project_id) / TARGETS_DIR).glob(f"{old.name}-*"):
            shutil.rmtree(parsed, ignore_errors=True)


async def _parse(project: Project, folder: Path, out: Path, target: str | None) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    req = RunRequest(
        project_id=project.id, project_path=folder, command="parse",
        extra=("--target-path", str(out), *(("--target", target) if target else ())),
        env=await load_project_env(project.id),
    )
    code, stdout, stderr = await runner.run(req)
    manifest = out / "semantic_manifest.json"
    if code != 0 or not manifest.exists():
        text = (stdout + stderr).decode(errors="replace")
        _, sep, after = text.rpartition("Encountered an error:")
        raise RevisionError("parse_failed", ((after if sep else text).strip() or "dbt parse failed")[-1500:])
    return manifest


async def side_manifest(project: Project, *, ref: str | None, target: str | None) -> SideManifest:
    """The semantic manifest for `ref` (None: the working copy) parsed for `target` (None: the active one)."""
    project_path = Path(project.path)
    if ref is None and target is None:
        return SideManifest(service.target_dir(project_path) / "semantic_manifest.json", None, None)
    async with _lock(project.id):
        if ref is None:
            folder, sha, notes = project_path, None, []
        else:
            folder, sha, notes = await _checkout(project, ref)
        out = compare_dir(project.id) / TARGETS_DIR / f"{sha[:12] if sha else 'working'}-{target or 'active'}"
        cached = out / "semantic_manifest.json"
        path = cached if sha and cached.exists() else await _parse(project, folder, out, target)
        return SideManifest(path, sha, target, tuple(notes))
