"""The Marked as expected log (plan 30): table metric_monitor_expectations.

Marking a monitor period as expected writes a row with what detection said about it then
(value, expected, flag kind); undoing removes it. Rows aren't trimmed with the points, and
may link a metric note (`note_slug`).
"""

from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MetricMonitor, MetricMonitorExpectation

MAX_LISTED = 500


def detected_point(points: list[dict], period: str) -> dict | None:
    """detect()'s point for `period`, if any."""
    return next((p for p in points if p.get("period") == period), None)


async def record(
    session: AsyncSession, m: MetricMonitor, target: str, slice_: str, period: str,
    point: dict | None, note_slug: str | None,
) -> MetricMonitorExpectation:
    """Write (or refresh) the log row for a period just marked as expected."""
    row = (await session.execute(
        select(MetricMonitorExpectation).where(
            MetricMonitorExpectation.monitor_id == m.id,
            MetricMonitorExpectation.target == target,
            MetricMonitorExpectation.slice == slice_,
            MetricMonitorExpectation.period == period,
        )
    )).scalar_one_or_none()
    if row is None:
        row = MetricMonitorExpectation(monitor_id=m.id, target=target, slice=slice_, period=period)
        session.add(row)
    kind = str((point or {}).get("kind") or "")
    row.metric = m.metric
    row.dimension = m.dimension
    row.value = (point or {}).get("value")
    row.expected = (point or {}).get("expected")
    row.kind = "" if kind == "none" else kind
    row.marked_at = datetime.now(UTC)
    if note_slug is not None:
        row.note_slug = note_slug or None
    await session.flush()
    return row


async def remove(session: AsyncSession, monitor_id: int, target: str, slice_: str, period: str) -> None:
    await session.execute(delete(MetricMonitorExpectation).where(
        MetricMonitorExpectation.monitor_id == monitor_id,
        MetricMonitorExpectation.target == target,
        MetricMonitorExpectation.slice == slice_,
        MetricMonitorExpectation.period == period,
    ))


async def list_for_project(
    session: AsyncSession, project_id: int, monitor_id: int | None = None
) -> list[MetricMonitorExpectation]:
    query = (
        select(MetricMonitorExpectation)
        .join(MetricMonitor, MetricMonitor.id == MetricMonitorExpectation.monitor_id)
        .where(MetricMonitor.project_id == project_id)
        .order_by(MetricMonitorExpectation.marked_at.desc(), MetricMonitorExpectation.id.desc())
        .limit(MAX_LISTED)
    )
    if monitor_id is not None:
        query = query.where(MetricMonitorExpectation.monitor_id == monitor_id)
    return list((await session.execute(query)).scalars())


async def get_for_project(session: AsyncSession, project_id: int, expectation_id: int) -> MetricMonitorExpectation | None:
    return (await session.execute(
        select(MetricMonitorExpectation)
        .join(MetricMonitor, MetricMonitor.id == MetricMonitorExpectation.monitor_id)
        .where(MetricMonitor.project_id == project_id, MetricMonitorExpectation.id == expectation_id)
    )).scalar_one_or_none()


def to_dto(row: MetricMonitorExpectation, note_slugs: set[str] | None) -> dict:
    """`note_missing`: the linked note's file is gone (deleted or renamed outside wickd)."""
    marked = row.marked_at if row.marked_at is None or row.marked_at.tzinfo else row.marked_at.replace(tzinfo=UTC)
    return {
        "id": row.id, "monitor_id": row.monitor_id, "target": row.target or None, "slice": row.slice,
        "period": row.period, "metric": row.metric, "dimension": row.dimension, "value": row.value,
        "expected": row.expected, "kind": row.kind, "note_slug": row.note_slug,
        "note_missing": bool(row.note_slug) and note_slugs is not None and row.note_slug not in note_slugs,
        "marked_at": marked.isoformat() if marked else None,
    }
