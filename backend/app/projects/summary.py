"""Lightweight per-project summaries for the home page project cards.

The home page shows node-type counts and the latest run for every project.
Fetching the full graph per card meant N manifest parses + 2N requests, which
the browser's per-host connection cap drains a few at a time. This module
counts node types straight from manifest.json (cached by mtime/size so repeat
loads are free) and is served for all projects in one request.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

from app.logging_setup import get_logger

log = get_logger(__name__)


@dataclass(frozen=True)
class NodeCounts:
    models: int
    sources: int
    seeds: int
    tests: int
    semantic_models: int = 0
    metrics: int = 0
    saved_queries: int = 0
    macros: int = 0


_CacheKey = tuple[int, int]  # (mtime_ns, size)

_cache: dict[str, tuple[_CacheKey, NodeCounts]] = {}
_cache_lock = Lock()


def _dict_len(value: object) -> int:
    return len(value) if isinstance(value, dict) else 0


def _shown_macro_count(macros: object) -> int:
    """Macros the Docs page lists: every package's, minus `docs: {show: false}`."""
    if not isinstance(macros, dict):
        return 0
    count = 0
    for raw in macros.values():
        if not isinstance(raw, dict):
            continue
        docs_cfg = raw.get("docs") or (raw.get("config") or {}).get("docs") or {}
        if isinstance(docs_cfg, dict) and docs_cfg.get("show") is False:
            continue
        count += 1
    return count


def _count_from_manifest(data: dict) -> NodeCounts:
    raw_nodes = data.get("nodes") or {}
    by_type: dict[str, int] = {}
    for raw in raw_nodes.values():
        if isinstance(raw, dict):
            rt = raw.get("resource_type")
            if isinstance(rt, str):
                by_type[rt] = by_type.get(rt, 0) + 1
    return NodeCounts(
        models=by_type.get("model", 0),
        sources=_dict_len(data.get("sources")),
        seeds=by_type.get("seed", 0),
        tests=by_type.get("test", 0),
        semantic_models=_dict_len(data.get("semantic_models")),
        metrics=_dict_len(data.get("metrics")),
        saved_queries=_dict_len(data.get("saved_queries")),
        macros=_shown_macro_count(data.get("macros")),
    )


def manifest_node_counts(project_path: Path) -> NodeCounts | None:
    """Node-type counts from `<project>/target/manifest.json`, or None if it is missing/unreadable."""
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
        log.warning("summary_manifest_read_failed", path=cache_id, error=str(exc))
        return None
    if not isinstance(data, dict):
        return None
    counts = _count_from_manifest(data)
    with _cache_lock:
        _cache[cache_id] = (key, counts)
    return counts
