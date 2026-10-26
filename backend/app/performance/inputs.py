"""Plain-data inputs for performance analysis, built from run history rows and
the manifest. Pure (no DB, no I/O), so the shapes crossing into wickd_pro are
unit-tested here — see app/performance/pro.py for the contract.
"""

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from statistics import median
from typing import Any, Protocol

from app.dbt.manifest import Manifest, ModelNode


class ResultRow(Protocol):
    """The InvocationModelResult columns this module reads."""

    invocation_id: int
    unique_id: str
    name: str
    status: str
    execution_time: float | None
    started_at: datetime | None
    completed_at: datetime | None
    thread_id: str | None
    rows_affected: int | None
    bytes_processed: int | None


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def _resource_type(uid: str, node: ModelNode | None) -> str:
    return node.resource_type if node is not None else uid.split(".", 1)[0]


def run_nodes(rows: Iterable[ResultRow], by_uid: dict[str, ModelNode]) -> list[dict[str, Any]]:
    out = []
    for r in rows:
        node = by_uid.get(r.unique_id)
        out.append({
            "unique_id": r.unique_id,
            "name": node.name if node is not None else r.name,
            "resource_type": _resource_type(r.unique_id, node),
            "materialized": node.materialized if node is not None else None,
            "status": r.status,
            "started_at": _iso(r.started_at),
            "completed_at": _iso(r.completed_at),
            "execution_time": r.execution_time,
            "thread_id": r.thread_id,
            "rows_affected": r.rows_affected,
            "bytes_processed": r.bytes_processed,
        })
    return out


def run_parents(manifest: Manifest | None, uids: set[str]) -> dict[str, list[str]]:
    parents = manifest.parents if manifest is not None else {}
    return {uid: [p for p in parents.get(uid, ()) if p in uids] for uid in uids}


def _children(manifest: Manifest) -> dict[str, list[str]]:
    children: dict[str, list[str]] = {}
    for child, parents in manifest.parents.items():
        for p in parents:
            children.setdefault(p, []).append(child)
    return children


def nodes_meta(
    manifest: Manifest | None, rows: Iterable[ResultRow]
) -> dict[str, dict[str, Any]]:
    """Static facts about each node in the run (materialization, columns, children)."""
    by_uid = {n.unique_id: n for n in manifest.nodes} if manifest is not None else {}
    children = _children(manifest) if manifest is not None else {}
    meta = {}
    for r in rows:
        node = by_uid.get(r.unique_id)
        meta[r.unique_id] = {
            "name": node.name if node is not None else r.name,
            "resource_type": _resource_type(r.unique_id, node),
            "materialized": node.materialized if node is not None else None,
            "columns": [c.name for c in node.columns] if node is not None else [],
            "children": children.get(r.unique_id, []),
            "rows_affected": r.rows_affected,
        }
    return meta


def successful_times(rows: Iterable[ResultRow]) -> dict[str, list[float]]:
    """unique_id → execution times of successful runs, in the rows' order (pass oldest first)."""
    times: dict[str, list[float]] = {}
    for r in rows:
        if r.status == "success" and r.execution_time is not None:
            times.setdefault(r.unique_id, []).append(r.execution_time)
    return times


def regression_history(
    current: Sequence[ResultRow], earlier: Iterable[ResultRow]
) -> list[dict[str, Any]]:
    """For each successful node in `current`, its earlier successful times (oldest first)."""
    previous = successful_times(earlier)
    return [
        {
            "unique_id": r.unique_id,
            "name": r.name,
            "previous": previous.get(r.unique_id, []),
            "current": r.execution_time,
        }
        for r in current
        if r.status == "success" and r.execution_time is not None
    ]


def median_durations(rows: Iterable[ResultRow]) -> dict[str, dict[str, Any]]:
    """unique_id → {median_s, last_s, runs, recent} over successful runs (rows oldest first)."""
    return {
        uid: {"median_s": median(times), "last_s": times[-1], "runs": len(times), "recent": times}
        for uid, times in successful_times(rows).items()
    }
