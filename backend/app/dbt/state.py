"""The production ("state") manifest dbt compares with for slim builds (plan 18).

`STATE_SOURCE` (project setting) says where it comes from:

- `git:<ref>` (default: the repo's base branch — origin/HEAD, main, master): the ref is parsed in
  a worktree by app/dbt/revisions.py twice. For `--state` (what changed) it's parsed for the
  active target, so relations match the working copy and nothing differs just because targets
  do (a source without a `database` gets each target's own). For `--defer-state` and clone it's
  parsed for DIFF_BASE_TARGET, so defer and clone read prod. Assumes prod is deployed from that ref.
- `path:<folder>`: a folder of real prod artifacts (`manifest.json`, optionally
  `run_results.json` / `sources.json`) the user syncs from their orchestrator. More accurate for
  `state:modified` on configs that differ per target.

dbt's `--state` wants a folder, so a git-derived manifest is copied into
`<data_dir>/state/<project_id>/<sha12>-<target>/` (immutable per commit and target; `active` for
the comparison one).

Defer is a sticky per-project choice kept in the `state_defer` project env var: "" (off),
`defer`, or `favor` (defer with `--favor-state`).
"""

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.config import settings
from app.db.models import Project
from app.dbt.revisions import RevisionError, side_manifest
from app.git.changeset import ChangeSetError, resolve_base
from app.git.repo import find_repo_root
from app.git.runner import GitRequest, git_runner

STATE_SOURCE_KEY = "STATE_SOURCE"
DEFER_KEY = "state_defer"
BASE_TARGET_KEY = "DIFF_BASE_TARGET"
DEFER_VALUES = ("", "defer", "favor")

SourceKind = Literal["git", "path"]


class StateError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class StateSource:
    kind: SourceKind
    # git: the ref (None = the repo's base branch); path: the folder
    value: str | None


@dataclass(frozen=True)
class StateDir:
    # --state: the manifest selection compares with
    path: Path
    kind: SourceKind
    ref: str | None
    folder: str | None
    sha: str | None
    # the target the manifest's relations belong to (None: the active one / unknown)
    target: str | None
    generated_at: str | None
    dbt_version: str | None
    notes: tuple[str, ...] = field(default_factory=tuple)
    # --defer-state / clone's --state: prod's relations (None: the same as path)
    defer_path: Path | None = None

    @property
    def relations_path(self) -> Path:
        return self.defer_path or self.path


def parse_state_source(raw: str | None) -> StateSource:
    """`git:<ref>` / `path:<folder>`; empty means git with the default base branch."""
    text = (raw or "").strip()
    if not text:
        return StateSource("git", None)
    kind, sep, value = text.partition(":")
    if not sep or kind not in ("git", "path"):
        raise StateError("bad_source", f"STATE_SOURCE must look like git:main or path:/folder (got {text!r}).")
    value = value.strip()
    if kind == "path":
        if not value:
            raise StateError("bad_source", "STATE_SOURCE path: needs a folder, e.g. path:/srv/dbt/prod-artifacts.")
        return StateSource("path", value)
    return StateSource("git", value or None)


def parse_defer(raw: str | None) -> tuple[bool, bool]:
    """(defer, favor_state) from the stored `state_defer` value."""
    value = (raw or "").strip()
    return value in ("defer", "favor"), value == "favor"


def read_manifest_metadata(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StateError("bad_manifest", f"Couldn't read {path}: {exc}") from exc
    metadata = data.get("metadata") if isinstance(data, dict) else None
    if not isinstance(metadata, dict) or not metadata.get("dbt_schema_version"):
        raise StateError("bad_manifest", f"{path} doesn't look like a dbt manifest (no metadata.dbt_schema_version).")
    return metadata


def _minor(version: str | None) -> str | None:
    if not version:
        return None
    parts = version.split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else version


def version_notes(state_version: str | None, project_path: Path) -> list[str]:
    """A note when the state manifest was written by another dbt minor version than this project's."""
    try:
        local = read_manifest_metadata(project_path / "target" / "manifest.json").get("dbt_version")
    except StateError:
        return []
    if _minor(state_version) and _minor(local) and _minor(state_version) != _minor(local):
        return [(f"The state manifest was written by dbt {state_version} and this project uses dbt {local}; "
                 "dbt may refuse to defer to a manifest from another minor version.")]
    return []


def validate_folder(folder: str, project_path: Path) -> StateDir:
    path = Path(folder).expanduser()
    if not path.is_absolute():
        path = project_path / path
    if not path.is_dir():
        raise StateError("missing_folder", f"The state folder {path} doesn't exist.")
    manifest = path / "manifest.json"
    if not manifest.is_file():
        raise StateError("missing_manifest", f"{path} has no manifest.json. Copy your production run's artifacts there.")
    metadata = read_manifest_metadata(manifest)
    version = metadata.get("dbt_version")
    return StateDir(
        path=path, kind="path", ref=None, folder=str(path), sha=None, target=None,
        generated_at=metadata.get("generated_at"), dbt_version=version,
        notes=tuple(version_notes(version, project_path)),
    )


def state_root(project_id: int) -> Path:
    return settings.data_dir / "state" / str(project_id)


async def _default_ref(project: Project) -> str:
    repo = find_repo_root(Path(project.path))
    if repo is None:
        raise StateError("not_a_repo", "This project isn't in a git repository. Set STATE_SOURCE to path:<folder of prod artifacts>.")

    async def git(*args: str) -> tuple[int, str]:
        return await git_runner.run(GitRequest(project_id=project.id, repo_root=repo, args=args))

    try:
        return await resolve_base(git, None)
    except ChangeSetError as exc:
        raise StateError("no_base", f"{exc} Set STATE_SOURCE to git:<branch>.") from exc


async def _git_copy(project: Project, ref: str, target: str | None) -> tuple[Path, str, tuple[str, ...]]:
    """(state folder, sha, notes) for `ref` parsed for `target` (None: the active one)."""
    try:
        side = await side_manifest(project, ref=ref, target=target)
    except RevisionError as exc:
        raise StateError(exc.code, exc.message) from exc
    sha = side.sha or ""
    dest = state_root(project.id) / f"{sha[:12]}-{target or 'active'}"
    manifest = dest / "manifest.json"
    if not manifest.exists():
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(side.path.parent / "manifest.json", manifest)
    return dest, sha, side.notes


async def _git_state(project: Project, ref: str | None, base_target: str | None, active_target: str | None) -> StateDir:
    resolved = ref or await _default_ref(project)
    compare, sha, side_notes = await _git_copy(project, resolved, active_target)
    relations = (await _git_copy(project, resolved, base_target))[0] if base_target and base_target != active_target else None
    metadata = read_manifest_metadata(compare / "manifest.json")
    notes = list(side_notes)
    if not base_target:
        notes.append(f"{BASE_TARGET_KEY} isn't set, so defer and clone would read your own relations, not prod. "
                     "Set it (Environment → Project settings) to your prod target.")
    notes.append(f"Parsed from {resolved} ({sha[:7]}), assuming prod is deployed from it. "
                 "Point STATE_SOURCE at a folder of real prod artifacts for exact results.")
    return StateDir(
        path=compare, kind="git", ref=resolved, folder=None, sha=sha, target=base_target,
        generated_at=metadata.get("generated_at"), dbt_version=metadata.get("dbt_version"), notes=tuple(notes),
        defer_path=relations,
    )


async def state_dir(project: Project, env: dict[str, str]) -> StateDir:
    """Resolve the project's state folder (parsing the git ref when needed). Raises StateError."""
    source = parse_state_source(env.get(STATE_SOURCE_KEY))
    if source.kind == "path":
        return validate_folder(source.value or "", Path(project.path))
    return await _git_state(project, source.value, env.get(BASE_TARGET_KEY) or None, env.get("DBT_TARGET") or None)


def state_args(resolved: StateDir, *, state: bool, defer: bool, favor_state: bool) -> tuple[str, ...]:
    """CLI args for a run: `--state` (the comparison manifest) for state: selectors, then
    `--defer --defer-state` (prod's relations; dbt 1.6+) for defer."""
    args: tuple[str, ...] = ("--state", str(resolved.path)) if state else ()
    if defer:
        args += ("--defer", "--defer-state", str(resolved.relations_path))
        if favor_state:
            args += ("--favor-state",)
    return args


@dataclass(frozen=True)
class RunState:
    args: tuple[str, ...]
    # what run_invocations.state_json records (None: neither state nor defer)
    record: dict | None


# dbt commands that accept --state / --defer here
STATE_COMMANDS = frozenset({"run", "build", "test", "clone", "ls"})


async def resolve_run_state(
    project: Project, env: dict[str, str], command: str, *,
    state: bool, defer: bool | None, favor_state: bool | None,
) -> RunState:
    """Args and record for one run. `defer`/`favor_state` None = the project's sticky choice."""
    sticky_defer, sticky_favor = parse_defer(env.get(DEFER_KEY))
    use_defer = (sticky_defer if defer is None else defer) and command in STATE_COMMANDS
    use_favor = use_defer and (sticky_favor if favor_state is None else favor_state)
    if not (state or use_defer):
        return RunState((), None)
    resolved = await state_dir(project, env)
    record = {
        "kind": resolved.kind, "ref": resolved.ref, "folder": resolved.folder,
        "sha": resolved.sha[:12] if resolved.sha else None, "target": resolved.target,
        "state": state, "defer": use_defer, "favor_state": use_favor,
    }
    if command == "clone":  # clone copies prod's relations: its --state is the relations manifest
        return RunState(("--state", str(resolved.relations_path)), record)
    return RunState(state_args(resolved, state=state, defer=use_defer, favor_state=use_favor), record)
