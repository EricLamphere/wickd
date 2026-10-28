"""A metric monitor's stored history (table metric_monitor_points), per dbt target and slice."""

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MetricMonitorPoint
from app.semantic.monitor_queries import period_ended


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


async def upsert(
    session: AsyncSession,
    monitor_id: int,
    target: str,
    slice_: str,
    values: Sequence[tuple[str, float | None]],
    *,
    grain: str,
    now: datetime,
    window_start: str,
) -> list[dict]:
    """Store `values`, the query's rows from `window_start` on; returns what was stored
    before for those periods (detect()'s `previous`). A stored period in the window
    that's no longer in the rows becomes a gap (None).

    A changed value keeps the one it replaced in `previous_value` only when that one was
    observed after its period had ended — an in-progress period always changes."""
    existing = {
        row.period: row
        for row in (await session.execute(
            select(MetricMonitorPoint).where(
                MetricMonitorPoint.monitor_id == monitor_id,
                MetricMonitorPoint.target == target,
                MetricMonitorPoint.slice == slice_,
                MetricMonitorPoint.period >= window_start,
            )
        )).scalars()
    }
    previous = [
        {"period": row.period, "value": row.value, "observed_at": _as_utc(row.observed_at).isoformat()}
        for row in existing.values()
    ]
    given = {period for period, _ in values}
    gone = [(period, None) for period in existing if period not in given]
    for period, value in [*values, *gone]:
        row = existing.get(period)
        if row is None:
            session.add(MetricMonitorPoint(
                monitor_id=monitor_id, target=target, slice=slice_, period=period, value=value, observed_at=now,
            ))
            continue
        if row.value != value and row.value is not None and period_ended(period, grain, _as_utc(row.observed_at)):
            row.previous_value = row.value
        row.value = value
        row.observed_at = now
    return previous


async def has_history(session: AsyncSession, monitor_id: int, target: str, slices: Sequence[str]) -> bool:
    """Whether every one of `slices` already has stored points on this target."""
    rows = (await session.execute(
        select(MetricMonitorPoint.slice, func.count())
        .where(MetricMonitorPoint.monitor_id == monitor_id, MetricMonitorPoint.target == target)
        .group_by(MetricMonitorPoint.slice)
    )).all()
    stored = {s for s, n in rows if n}
    return bool(slices) and all(s in stored for s in slices)


async def series(session: AsyncSession, monitor_id: int, target: str, slice_: str, since: str) -> list[dict]:
    rows = (await session.execute(
        select(MetricMonitorPoint)
        .where(
            MetricMonitorPoint.monitor_id == monitor_id,
            MetricMonitorPoint.target == target,
            MetricMonitorPoint.slice == slice_,
            MetricMonitorPoint.period >= since,
        )
        .order_by(MetricMonitorPoint.period)
    )).scalars()
    return [{"period": r.period, "value": r.value, "suppressed": r.suppressed} for r in rows]


async def restatements(session: AsyncSession, monitor_id: int, target: str, slice_: str) -> list[dict]:
    rows = (await session.execute(
        select(MetricMonitorPoint)
        .where(
            MetricMonitorPoint.monitor_id == monitor_id,
            MetricMonitorPoint.target == target,
            MetricMonitorPoint.slice == slice_,
            MetricMonitorPoint.previous_value.is_not(None),
        )
        .order_by(MetricMonitorPoint.period.desc())
    )).scalars()
    return [
        {"period": r.period, "value": r.value, "previous_value": r.previous_value,
         "observed_at": _as_utc(r.observed_at).isoformat()}
        for r in rows
    ]


async def trim(session: AsyncSession, monitor_id: int, target: str, before: str) -> None:
    """Drop history older than the monitor's lookback."""
    await session.execute(
        delete(MetricMonitorPoint).where(
            MetricMonitorPoint.monitor_id == monitor_id,
            MetricMonitorPoint.target == target,
            MetricMonitorPoint.period < before,
        )
    )


async def set_suppressed(
    session: AsyncSession, monitor_id: int, target: str, slice_: str, period: str, suppressed: bool
) -> bool:
    row = (await session.execute(
        select(MetricMonitorPoint).where(
            MetricMonitorPoint.monitor_id == monitor_id,
            MetricMonitorPoint.target == target,
            MetricMonitorPoint.slice == slice_,
            MetricMonitorPoint.period == period,
        )
    )).scalar_one_or_none()
    if row is None:
        return False
    row.suppressed = suppressed
    return True


async def delete_all(session: AsyncSession, monitor_id: int) -> None:
    await session.execute(delete(MetricMonitorPoint).where(MetricMonitorPoint.monitor_id == monitor_id))
