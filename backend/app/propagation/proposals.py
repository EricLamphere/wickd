"""Turn propagation results into a reviewable multi-file proposal (kind "propagate").

Every inherited description or set of tags is one item, keyed per column, and
lands in that node's schema YAML (the file the docs generator would use). A
file's text is always derived from its original plus the chosen items, through
the same splicers and safety checks as AI docs and tests — render_file() is
what both the initial build and partial accept (app/ai/selection.py) use.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from app.ai.documentation import FileChange
from app.dbt.schema_column_tags import add_column_tags
from app.dbt.schema_descriptions import raw_descriptions, raw_source_descriptions, set_descriptions
from app.dbt.schema_yaml import (
    RESOURCE_KEYS,
    DocumentTarget,
    SchemaYamlError,
    _read,
    node_text,
    plan_document_node,
)
from app.logging_setup import get_logger

log = get_logger(__name__)

KIND = "propagate"
DESCRIPTION = "description"
TAGS = "tags"


@dataclass(frozen=True)
class PropagationChanges:
    changes: tuple[FileChange, ...]
    items: tuple[dict, ...]  # the items that made it into a file (each with "file")
    skipped: tuple[dict, ...]  # [{unique_id, reason}] nodes whose YAML couldn't be edited


def item_key(field: str, unique_id: str, column: str) -> str:
    return f"{field}:{unique_id}:{column.lower()}"


# ── Raw source descriptions ──────────────────────────────────────────────────


class RawDescriptions:
    """Descriptions as written in the source column's YAML, so `{{ doc('…') }}`
    stays a doc block. Falls back to the manifest's rendered text."""

    def __init__(self, project_path: Path, manifest: dict) -> None:
        self._root = project_path.resolve()
        self._nodes = {**(manifest.get("nodes") or {}), **(manifest.get("sources") or {})}
        self._cache: dict[str, dict[str, str]] = {}

    def _for_node(self, uid: str) -> dict[str, str]:
        if uid in self._cache:
            return self._cache[uid]
        node = self._nodes.get(uid) or {}
        found: dict[str, str] = {}
        try:
            if node.get("resource_type") == "source" and node.get("original_file_path"):
                path = self._file(node["original_file_path"])
                found = raw_source_descriptions(_read(path), path.name, node["source_name"], node["name"])
            elif node.get("patch_path") and node.get("resource_type") in RESOURCE_KEYS:
                path = self._file(node["patch_path"].split("://", 1)[-1])
                found = raw_descriptions(_read(path), path.name, RESOURCE_KEYS[node["resource_type"]], node["name"])
        except (SchemaYamlError, KeyError) as exc:
            log.info("propagate_raw_description_unavailable", unique_id=uid, error=str(exc))
        self._cache[uid] = {k.lower(): v for k, v in found.items()}
        return self._cache[uid]

    def _file(self, relative: str) -> Path:
        path = (self._root / relative).resolve()
        if not path.is_relative_to(self._root):
            raise SchemaYamlError(f"{relative!r} resolves outside the project")
        return path

    def get(self, uid: str, column: str, rendered: str) -> str:
        return self._for_node(uid).get(column.lower(), rendered)


# ── Items ────────────────────────────────────────────────────────────────────


def description_items(fills: Iterable[dict], raw: RawDescriptions) -> list[dict]:
    return [
        {
            "key": item_key(DESCRIPTION, f["unique_id"], f["column"]),
            "field": DESCRIPTION,
            "unique_id": f["unique_id"],
            "column": f["column"],
            "value": raw.get(f["source"]["node"], f["source"]["column"], f["description"]),
            "source": f["source"],
            "kind": f["kind"],
            "path": f["path"],
        }
        for f in fills
    ]


def tag_items(inherited: Iterable[dict]) -> list[dict]:
    return [
        {
            "key": item_key(TAGS, t["unique_id"], t["column"]),
            "field": TAGS,
            "unique_id": t["unique_id"],
            "column": t["column"],
            "tags": t["tags"],
            "via_kind": t["via_kind"],
        }
        for t in inherited
    ]


# ── Rendering ────────────────────────────────────────────────────────────────


def render_node(
    text: str | None, filename: str, resource_key: str, name: str, items: list[dict]
) -> str:
    """`text` (None → a new file) with the node's entry, its items' columns and their values."""
    out = node_text(text, filename, resource_key, name, [i["column"] for i in items])
    descriptions = {i["column"]: i["value"] for i in items if i["field"] == DESCRIPTION}
    if descriptions:
        out = set_descriptions(out, filename, resource_key, name, None, descriptions).text
    tags = {i["column"]: i["tags"] for i in items if i["field"] == TAGS}
    if tags:
        out = add_column_tags(out, filename, resource_key, name, tags)
    return out


def _by_node(items: Iterable[dict]) -> dict[tuple[str, str], list[dict]]:
    grouped: dict[tuple[str, str], list[dict]] = {}
    for item in items:
        grouped.setdefault((item["resource_key"], item["name"]), []).append(item)
    return grouped


def render_file(original: str | None, filename: str, items: Iterable[dict]) -> str:
    """The file's original text plus `items` (all of them in this file)."""
    text = original
    for (resource_key, name), node_items in _by_node(items).items():
        text = render_node(text, filename, resource_key, name, node_items)
    return text if text is not None else ""


def build_changes(project_path: Path, nodes: dict[str, dict], items: list[dict]) -> PropagationChanges:
    """One FileChange per schema file touched. `nodes` are the writable manifest
    nodes (inputs.writable_nodes); items for other nodes, or whose YAML can't be
    edited safely, are skipped and reported."""
    files: dict[str, dict] = {}  # path → {"original", "text"}
    applied: list[dict] = []
    skipped: list[dict] = []
    by_uid: dict[str, list[dict]] = {}
    for item in items:
        by_uid.setdefault(item["unique_id"], []).append(item)

    for uid, node_items in by_uid.items():
        node = nodes.get(uid)
        if node is None:
            skipped.append({"unique_id": uid, "reason": "not a model, seed or snapshot of this project"})
            continue
        target = DocumentTarget(
            name=node["name"],
            resource_type=node["resource_type"],
            original_file_path=node["original_file_path"],
            patch_path=node.get("patch_path"),
        )
        try:
            plan = plan_document_node(project_path, target, [])
            path = plan.result.path
            state = files.setdefault(path, {"original": plan.original, "text": plan.original})
            placed = [
                {**i, "file": path, "resource_key": plan.resource_key, "name": node["name"]}
                for i in node_items
            ]
            state["text"] = render_node(state["text"], plan.file.name, plan.resource_key, node["name"], placed)
        except SchemaYamlError as exc:
            skipped.append({"unique_id": uid, "reason": str(exc)})
            continue
        applied.extend(placed)

    changes = tuple(
        FileChange(path, state["original"], state["text"])
        for path, state in files.items()
        if state["text"] is not None and state["text"] != state["original"]
    )
    changed = {c.path for c in changes}
    return PropagationChanges(
        changes=changes,
        items=tuple(i for i in applied if i["file"] in changed),
        skipped=tuple(skipped),
    )
