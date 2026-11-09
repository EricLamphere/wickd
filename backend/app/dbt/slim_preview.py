"""Preview of a slim build (plan 18): what `dbt build --select state:…[+] --state <dir>` would run.

1. `dbt ls --select <method> --state <dir> --output json` through the runner, into its own
   `--target-path` (`<data_dir>/state/<project_id>/ls-target`) so the project's target/ — and
   with it run_results.json, which `dbt retry` reads — is never touched. That ls also writes a
   fresh manifest.json whose child_map gives the `+` (downstream) closure and parent_map.
2. dbt's modified set compared with the Impact tab's git change set (app/api/impact.py): they
   can differ, since dbt also sees config / contract changes and git sees whole files.
3. (Pro) the smallest safe selection: changed columns from both sides' compiled SQL, then
   column lineage prunes downstream nodes that read none of them (app/dbt/slim.py).
"""

import json
from dataclasses import dataclass
from pathlib import Path

from app.db.models import Project
from app.dbt.runner import RunRequest, runner
from app.dbt.state import StateDir, StateError, state_root

METHODS = (
    "state:modified", "state:new", "state:modified.body", "state:modified.configs", "state:modified.contract",
)
TEST_TYPES = frozenset({"test", "unit_test"})
UNBUILDABLE = frozenset({"exposure", "metric", "semantic_model", "saved_query", "analysis"})
COMPARED_TYPES = frozenset({"model", "seed", "snapshot", "source"})
_SECTIONS = ("nodes", "sources", "exposures", "metrics", "semantic_models", "saved_queries", "unit_tests")


@dataclass(frozen=True)
class Listed:
    unique_ids: tuple[str, ...]
    manifest: dict


def parse_ls_output(text: str) -> list[str]:
    """unique_ids from `dbt ls --output json` stdout (one JSON object per line among log lines)."""
    found: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        uid = item.get("unique_id") if isinstance(item, dict) else None
        if isinstance(uid, str) and uid not in found:
            found.append(uid)
    return found


def dbt_error(output: str) -> str:
    _, sep, after = output.rpartition("Encountered an error:")
    return ((after if sep else output).strip() or "dbt ls failed")[-1500:]


async def list_state(project: Project, env: dict[str, str], state: StateDir, method: str, target: str | None) -> Listed:
    out = state_root(project.id) / "ls-target"
    out.mkdir(parents=True, exist_ok=True)
    req = RunRequest(
        project_id=project.id, project_path=Path(project.path), command="ls", select=method,
        # empty: no tests pulled in for the selected models — only what dbt considers modified
        extra=("--state", str(state.path), "--indirect-selection", "empty", "--output", "json", "--target-path", str(out),
               *(("--target", target) if target else ())),
        env=env,
    )
    code, stdout, stderr = await runner.run(req)
    if code != 0:
        raise StateError("ls_failed", dbt_error((stdout + stderr).decode(errors="replace")))
    try:
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StateError("ls_failed", f"dbt ls didn't write a manifest: {exc}") from exc
    return Listed(tuple(parse_ls_output(stdout.decode(errors="replace"))), manifest)


def downstream(seeds: list[str], child_map: dict[str, list[str]]) -> list[str]:
    """The seeds and everything below them, seeds first then in discovery order."""
    seen = list(dict.fromkeys(seeds))
    known = set(seen)
    queue = list(seen)
    while queue:
        uid = queue.pop(0)
        for child in child_map.get(uid, []):
            if child not in known:
                known.add(child)
                seen.append(child)
                queue.append(child)
    return seen


def node(manifest: dict, uid: str) -> dict:
    for section in _SECTIONS:
        found = (manifest.get(section) or {}).get(uid)
        if found:
            return found
    return {}


def resource_type(manifest: dict, uid: str) -> str:
    return str(node(manifest, uid).get("resource_type") or uid.split(".")[0])


def selector_for(manifest: dict, uid: str) -> str | None:
    """dbt --select term for a buildable node; None for tests and nodes dbt build skips."""
    info = node(manifest, uid)
    kind = resource_type(manifest, uid)
    name = str(info.get("name") or uid.split(".")[-1])
    if kind in TEST_TYPES or kind in UNBUILDABLE:
        return None
    if kind == "source":
        return f"source:{info.get('source_name')}.{name}"
    version = info.get("version")
    return f"{name}.v{version}" if version is not None else name


def is_buildable(manifest: dict, uid: str) -> bool:
    """dbt build builds / runs it (models, seeds, snapshots, tests); not metrics, exposures, …"""
    return resource_type(manifest, uid) not in UNBUILDABLE and resource_type(manifest, uid) != "source"


def exact_selector(manifest: dict, uids: list[str]) -> str:
    return " ".join(sorted({s for s in (selector_for(manifest, u) for u in uids) if s}))


def is_protected(manifest: dict, uid: str) -> bool:
    """Contracted or versioned: its consumers are never pruned (plan 05 / 22 rules)."""
    info = node(manifest, uid)
    contract = (info.get("config") or {}).get("contract") or info.get("contract") or {}
    return bool(contract.get("enforced")) or info.get("version") is not None


def display_name(manifest: dict, uid: str) -> str:
    """A node's name; sources as `source:<source>.<table>` so they can't be mistaken for a seed or model."""
    info = node(manifest, uid)
    name = str(info.get("name") or uid.split(".")[-1])
    return f"source:{info.get('source_name')}.{name}" if resource_type(manifest, uid) == "source" else name


def compare_with_git(manifest: dict, dbt_changed: list[str], git_changed: list[str]) -> tuple[list[str], list[str]]:
    """(changed per dbt only, changed per git only) — names, buildable resource types only."""
    def names(uids: set[str]) -> list[str]:
        kept = [u for u in uids if resource_type(manifest, u) in COMPARED_TYPES]
        return sorted(display_name(manifest, u) for u in kept)
    dbt_set, git_set = set(dbt_changed), set(git_changed)
    return names(dbt_set - git_set), names(git_set - dbt_set)
