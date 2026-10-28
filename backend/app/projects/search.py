"""Search model / source / seed / snapshot / exposure names and column names across projects.

Backs the home page search: "which project has fct_orders?" or "where is
customer_id?". Each project's manifest.json is reduced to a small index
(cached by mtime/size, like `summary.py`), so repeat searches never re-parse.
Only projects that have been compiled (have a manifest) are searchable.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from app.logging_setup import get_logger

log = get_logger(__name__)

SEARCHABLE_NODE_TYPES = frozenset({"model", "seed", "snapshot"})
MAX_DESCRIPTION = 160

# Lower is better. Name matches always outrank column matches.
_NAME_EXACT, _NAME_PREFIX, _NAME_SUBSTRING = 0, 1, 2
_COLUMN_EXACT, _COLUMN_PREFIX, _COLUMN_SUBSTRING = 3, 4, 5


@dataclass(frozen=True)
class IndexedNode:
    unique_id: str
    name: str  # sources: "<source_name>.<table>"
    resource_type: str
    package_name: str | None
    original_file_path: str | None
    description: str
    columns: tuple[str, ...]


@dataclass(frozen=True)
class ProjectIndex:
    project_id: int
    project_name: str
    nodes: tuple[IndexedNode, ...]


@dataclass(frozen=True)
class SearchHit:
    project_id: int
    project_name: str
    unique_id: str
    name: str
    resource_type: str
    original_file_path: str | None
    description: str
    matched_column: str | None  # None when the node's name matched


def _str_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _column_names(raw: dict) -> tuple[str, ...]:
    columns = raw.get("columns")
    if not isinstance(columns, dict):
        return ()
    return tuple(name for name in columns if isinstance(name, str))


def _indexed(unique_id: str, raw: dict, resource_type: str) -> IndexedNode | None:
    name = _str_or_none(raw.get("name"))
    if name is None:
        return None
    source_name = _str_or_none(raw.get("source_name"))
    description = raw.get("description") if isinstance(raw.get("description"), str) else ""
    if len(description) > MAX_DESCRIPTION:
        description = description[:MAX_DESCRIPTION].rstrip() + "…"
    return IndexedNode(
        unique_id=unique_id,
        name=f"{source_name}.{name}" if resource_type == "source" and source_name else name,
        resource_type=resource_type,
        package_name=_str_or_none(raw.get("package_name")),
        original_file_path=_str_or_none(raw.get("original_file_path")),
        description=description,
        columns=_column_names(raw),
    )


def _section(data: dict, key: str) -> dict:
    section = data.get(key)
    return section if isinstance(section, dict) else {}


def build_index(data: dict) -> tuple[IndexedNode, ...]:
    """The searchable nodes of a parsed manifest.json. Tests and analyses are left out."""
    entries: list[IndexedNode] = []
    for unique_id, raw in _section(data, "nodes").items():
        if isinstance(raw, dict) and raw.get("resource_type") in SEARCHABLE_NODE_TYPES:
            node = _indexed(unique_id, raw, raw["resource_type"])
            if node is not None:
                entries.append(node)
    sections = (
        ("sources", "source"),
        ("exposures", "exposure"),
        ("semantic_models", "semantic_model"),
        ("metrics", "metric"),
        ("saved_queries", "saved_query"),
    )
    for key, resource_type in sections:
        for unique_id, raw in _section(data, key).items():
            if isinstance(raw, dict):
                node = _indexed(unique_id, raw, resource_type)
                if node is not None:
                    entries.append(node)
    return tuple(entries)


_CacheKey = tuple[int, int]  # (mtime_ns, size)

_cache: dict[str, tuple[_CacheKey, tuple[IndexedNode, ...]]] = {}
_cache_lock = Lock()


def manifest_index(project_path: Path) -> tuple[IndexedNode, ...] | None:
    """Search index for `<project>/target/manifest.json`, or None if it is missing/unreadable."""
    manifest_path = project_path / "target" / "manifest.json"
    try:
        stat = manifest_path.stat()
    except OSError:
        return None
    key: _CacheKey = (stat.st_mtime_ns, stat.st_size)
    cache_id = str(manifest_path)
    with _cache_lock:
        hit = _cache.get(cache_id)
    if hit is not None and hit[0] == key:
        return hit[1]
    try:
        data = json.loads(manifest_path.read_bytes())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("search_manifest_read_failed", path=cache_id, error=str(exc))
        return None
    if not isinstance(data, dict):
        return None
    index = build_index(data)
    with _cache_lock:
        _cache[cache_id] = (key, index)
    return index


def _text_score(text: str, q: str, exact: int, prefix: int, substring: int) -> int | None:
    if text == q:
        return exact
    if text.startswith(q):
        return prefix
    if q in text:
        return substring
    return None


def _score(node: IndexedNode, q: str) -> tuple[int, str | None] | None:
    """(score, matched column) for a lower-cased query, or None if the node doesn't match."""
    name = node.name.lower()
    # A source also matches on its bare table name ("orders" for "raw.orders").
    table = name.rsplit(".", 1)[-1] if node.resource_type == "source" else name
    name_score = _text_score(table, q, _NAME_EXACT, _NAME_PREFIX, _NAME_SUBSTRING)
    if name_score is None and table != name:
        name_score = _text_score(name, q, _NAME_EXACT, _NAME_PREFIX, _NAME_SUBSTRING)
    if name_score is not None:
        return name_score, None
    best: tuple[int, str | None] | None = None
    for column in node.columns:
        score = _text_score(column.lower(), q, _COLUMN_EXACT, _COLUMN_PREFIX, _COLUMN_SUBSTRING)
        if score is not None and (best is None or score < best[0]):
            best = (score, column)
            if score == _COLUMN_EXACT:
                break
    return best


def search_nodes(projects: list[ProjectIndex], query: str, limit: int) -> list[SearchHit]:
    """Best matches first: exact > prefix > substring, names before columns, then the
    project's own nodes before installed packages', then shorter names."""
    q = query.strip().lower()
    if not q:
        return []
    ranked: list[tuple[tuple, SearchHit]] = []
    for project in projects:
        for node in project.nodes:
            scored = _score(node, q)
            if scored is None:
                continue
            score, column = scored
            is_package = node.package_name is not None and node.package_name != project.project_name
            sort_key = (score, is_package, len(node.name), node.name.lower(), project.project_name.lower())
            ranked.append((sort_key, SearchHit(
                project_id=project.project_id,
                project_name=project.project_name,
                unique_id=node.unique_id,
                name=node.name,
                resource_type=node.resource_type,
                original_file_path=node.original_file_path,
                description=node.description,
                matched_column=column,
            )))
    ranked.sort(key=lambda pair: pair[0])
    return [hit for _, hit in ranked[:limit]]
