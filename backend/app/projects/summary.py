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


_CacheKey = tuple[int, int]  # (mtime_ns, size)

_cache: dict[str, tuple[_CacheKey, NodeCounts]] = {}
_cache_lock = Lock()


def _count_from_manifest(data: dict) -> NodeCounts:
    raw_nodes = data.get("nodes") or {}
    by_type: dict[str, int] = {}
    for raw in raw_nodes.values():
        if isinstance(raw, dict):
            rt = raw.get("resource_type")
            if isinstance(rt, str):
                by_type[rt] = by_type.get(rt, 0) + 1
    sources = data.get("sources") or {}
    return NodeCounts(
        models=by_type.get("model", 0),
        sources=len(sources) if isinstance(sources, dict) else 0,
        seeds=by_type.get("seed", 0),
        tests=by_type.get("test", 0),
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
