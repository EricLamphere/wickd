"""Follow a generic test across a YAML edit that renames it.

dbt names a generic test from its arguments (`accepted_values_orders_status__a__b`), so editing
them in YAML renames the node. The manifest only catches up on the next dbt command, so a run
selected by the old name would find nothing. Before such a run, resolve_test_name() re-parses
the project when a YAML file is newer than the manifest and returns the test's new name,
matched on what a config edit doesn't change: the tested node, the test type, the column and
the YAML file it's defined in.
"""

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, NamedTuple

from app.dbt.runner import RunRequest, runner
from app.logging_setup import get_logger

log = get_logger(__name__)

PARSE_TIMEOUT_S = 120.0
_YAML_SUFFIXES = (".yml", ".yaml")
# one node by name, with optional graph operators (`+name+`): a selector worth re-resolving
_BARE_SELECTOR = re.compile(r"^(\+?)([A-Za-z0-9_]+)(\+?)$")
_SKIP_DIRS = frozenset({"target", "dbt_packages", "dbt_modules", "logs", "node_modules", "venv"})


class TestIdentity(NamedTuple):
    attached_node: str | None
    test_type: str
    namespace: str | None
    column_name: str | None
    file_path: str | None


def _tests(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    return [n for n in (manifest.get("nodes") or {}).values() if n.get("resource_type") == "test"]


def _identity(node: dict[str, Any]) -> TestIdentity | None:
    meta = node.get("test_metadata")
    if not meta or not meta.get("name"):
        return None  # a singular test: named after its file, a config edit can't rename it
    return TestIdentity(
        attached_node=node.get("attached_node"),
        test_type=meta["name"],
        namespace=meta.get("namespace"),
        column_name=node.get("column_name"),
        file_path=node.get("original_file_path"),
    )


def test_identity(manifest: dict[str, Any], name: str) -> TestIdentity | None:
    """The identity of the generic test called `name`, or None (not a generic test)."""
    for node in _tests(manifest):
        if node.get("name") == name:
            return _identity(node)
    return None


def renamed_test(
    old: dict[str, Any], new: dict[str, Any], name: str, identity: TestIdentity,
) -> str | None:
    """The test's name in `new`: unchanged if it still exists, else the one test matching
    `identity` (preferring names `old` didn't have), else None."""
    new_names = {n.get("name") for n in _tests(new)}
    if name in new_names:
        return name
    matches = [n["name"] for n in _tests(new) if _identity(n) == identity]
    if len(matches) > 1:
        old_names = {n.get("name") for n in _tests(old)}
        matches = [m for m in matches if m not in old_names]
    return matches[0] if len(matches) == 1 else None


def yaml_newer_than(project_path: Path, mtime: float) -> bool:
    """Whether any project YAML (outside build output, packages and virtualenvs) changed after `mtime`."""
    for root, dirs, files in os.walk(project_path):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
        for f in files:
            if f.endswith(_YAML_SUFFIXES):
                try:
                    if os.stat(os.path.join(root, f)).st_mtime > mtime:
                        return True
                except OSError:
                    continue
    return False


def _read_manifest(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _stale_test(project_path: Path, name: str) -> tuple[dict[str, Any], TestIdentity] | None:
    """The current manifest and the test's identity, when `name` is a generic test and the
    manifest is older than some YAML; else None (nothing to re-resolve)."""
    path = project_path / "target" / "manifest.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    if not yaml_newer_than(project_path, mtime):
        return None
    manifest = _read_manifest(path)
    identity = test_identity(manifest, name) if manifest else None
    return (manifest, identity) if manifest and identity else None


async def resolve_test_name(
    project_id: int, project_path: Path, name: str, env: dict[str, str] | None, target: str | None,
) -> str:
    """`name`, or the generic test's new name after re-parsing the edited YAML. Never raises:
    on any failure the original name is returned and dbt reports what it finds."""
    try:
        stale = await asyncio.to_thread(_stale_test, project_path, name)
        if stale is None:
            return name
        old, identity = stale
        req = RunRequest(
            project_id=project_id, project_path=project_path, command="parse",
            extra=("--target", target) if target else (), env=env,
        )
        code, _, stderr = await runner.run(req, timeout=PARSE_TIMEOUT_S)
        if code != 0:
            log.info("test_rename_parse_failed", project_id=project_id, stderr=stderr.decode(errors="replace")[-300:])
            return name
        new = await asyncio.to_thread(_read_manifest, project_path / "target" / "manifest.json")
        resolved = renamed_test(old, new, name, identity) if new else None
        if resolved and resolved != name:
            log.info("test_renamed", project_id=project_id, old=name, new=resolved)
        return resolved or name
    except Exception as exc:  # noqa: BLE001 — resolving is best effort; the run must still start
        log.warning("test_rename_error", project_id=project_id, name=name, error=str(exc))
        return name


async def resolve_test_selector(
    project_id: int, project_path: Path, select: str, env: dict[str, str] | None, target: str | None,
) -> str:
    """`select` with a renamed generic test's new name, when it selects one node by name
    (graph operators kept); any other selector is returned unchanged."""
    m = _BARE_SELECTOR.match(select.strip())
    if not m:
        return select
    prefix, name, suffix = m.groups()
    resolved = await resolve_test_name(project_id, project_path, name, env, target)
    return select if resolved == name else f"{prefix}{resolved}{suffix}"
