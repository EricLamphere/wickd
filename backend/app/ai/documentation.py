"""AI documentation: descriptions for a model and its columns, as a proposed file change.

Builds on the plain docs generator (app/dbt/schema_yaml.py): the node's entry
and its columns are added the same way, then the model's descriptions are
spliced in (app/dbt/schema_descriptions.py). Nothing is written here — the
result becomes an AiProposal the user reviews.
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from app.ai import pro
from app.ai.client import stream_chat
from app.ai.config import AiConfig
from app.ai.errors import NothingToPropose, ProposalError
from app.ai.provider import resolve_provider
from app.ai.runtime import llama_server
from app.dbt.probe import probe_warehouse_columns
from app.dbt.schema_descriptions import existing_descriptions, set_descriptions
from app.dbt.schema_yaml import RESOURCE_KEYS, DocumentTarget, plan_document_node
from app.logging_setup import get_logger

log = get_logger(__name__)

# More columns than this per request overflows a small model's context/output.
MAX_AI_COLUMNS = 150


class DocumentationError(ProposalError):
    """The node can't be documented (with a user-facing reason)."""


class NothingToDocument(DocumentationError, NothingToPropose):
    """Every description is already filled in — an outcome, not a failure."""


# Progress callbacks: the current phase ("columns" | "writing"), and the model's
# JSON answer so far each time it grows.
PhaseCallback = Callable[[str], Awaitable[None]]
TextCallback = Callable[[str], Awaitable[None]]


async def _noop(_: str) -> None:
    return None


@dataclass(frozen=True)
class FileChange:
    path: str  # relative to the project root (posix)
    original: str | None  # None → the file is new
    proposed: str


@dataclass(frozen=True)
class DocumentationResult:
    change: FileChange
    # what the proposal sets: {"description": str | None, "columns": {name: description}}
    summary: dict
    skipped_columns: int  # over MAX_AI_COLUMNS


def load_manifest_dict(project_path: Path) -> dict:
    path = project_path / "target" / "manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise DocumentationError("manifest not found — compile the project first") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise DocumentationError(f"could not read manifest.json: {exc}") from exc


def _manifest_columns(project_path: Path, node: dict, unique_id: str) -> list[str]:
    """Documented columns, plus any the last `dbt docs generate` catalog saw."""
    names = list((node.get("columns") or {}).keys())
    try:
        catalog = json.loads((project_path / "target" / "catalog.json").read_text())
        entry = (catalog.get("nodes") or {}).get(unique_id) or {}
        names += list((entry.get("columns") or {}).keys())
    except (OSError, json.JSONDecodeError):
        pass
    seen: set[str] = set()
    return [n for n in names if not (n.lower() in seen or seen.add(n.lower()))]


async def node_columns(
    project_id: int, project_path: Path, node: dict, unique_id: str, env: dict[str, str]
) -> list[str]:
    """The node's real columns from the warehouse, else whatever the project knows about."""
    probe = await probe_warehouse_columns(
        project_id, project_path, node["name"], env, env.get("DBT_TARGET")
    )
    if probe.error is None:
        return list(probe.columns)
    log.info("ai_document_probe_failed", unique_id=unique_id, error=probe.error)
    return _manifest_columns(project_path, node, unique_id)


async def generate_documentation(
    *,
    project_id: int,
    project_path: Path,
    unique_id: str,
    env: dict[str, str],
    config: AiConfig,
    overwrite: bool,
    on_phase: PhaseCallback = _noop,
    on_text: TextCallback = _noop,
) -> DocumentationResult:
    manifest = await asyncio.to_thread(load_manifest_dict, project_path)
    node = (manifest.get("nodes") or {}).get(unique_id)
    if not isinstance(node, dict):
        raise DocumentationError("node not found in the manifest")
    if node.get("resource_type") not in RESOURCE_KEYS or not node.get("original_file_path"):
        raise DocumentationError(f"documenting a {node.get('resource_type')} is not supported")

    await on_phase("columns")
    columns = await node_columns(project_id, project_path, node, unique_id, env)
    target = DocumentTarget(
        name=node["name"],
        resource_type=node["resource_type"],
        original_file_path=node["original_file_path"],
        patch_path=node.get("patch_path"),
    )
    plan = await asyncio.to_thread(plan_document_node, project_path, target, columns)

    # Only ask the model for what's missing (everything, with overwrite).
    existing = existing_descriptions(plan.text, plan.file.name, plan.resource_key, target.name)
    missing = [c for c in columns if overwrite or c.lower() not in existing.columns]
    if not missing and existing.node and not overwrite:
        raise NothingToDocument(
            "Everything already has a description. Choose “Rewrite all” to replace them."
        )
    asked = missing[:MAX_AI_COLUMNS]
    prompt = pro.documentation_prompt(manifest, unique_id, asked)
    await on_phase("writing")
    provider = await resolve_provider(config)
    parts: list[str] = []
    async for delta in stream_chat(
        provider, prompt["messages"], max_tokens=prompt.get("max_tokens"), schema=prompt["schema"]
    ):
        parts.append(delta)
        llama_server.touch()
        await on_text("".join(parts))
    raw = "".join(parts).strip()
    try:
        parsed = pro.parse_documentation(raw, asked)
    except ValueError as exc:
        log.warning("ai_document_unparseable", unique_id=unique_id, error=str(exc), raw=raw[:500])
        raise DocumentationError(f"the model's answer wasn't usable: {exc}") from exc

    changes = set_descriptions(
        plan.text,
        plan.file.name,
        plan.resource_key,
        target.name,
        parsed.get("description"),
        parsed.get("columns") or {},
        overwrite=overwrite,
    )
    if changes.text == (plan.original or ""):
        raise NothingToDocument(
            "Everything already has a description."
            + ("" if overwrite else " Choose “Rewrite all” to replace them.")
        )
    described = {c.lower() for c in changes.columns}
    summary = {
        "description": parsed.get("description") if changes.node else None,
        "columns": {k: v for k, v in (parsed.get("columns") or {}).items() if k.lower() in described},
        # how to rebuild the file for a subset of items (app/ai/selection.py)
        "plan": {
            "resource_key": plan.resource_key,
            "name": target.name,
            "columns": list(columns),
            "overwrite": overwrite,
        },
    }
    return DocumentationResult(
        change=FileChange(plan.result.path, plan.original, changes.text),
        summary=summary,
        skipped_columns=max(0, len(missing) - MAX_AI_COLUMNS),
    )
