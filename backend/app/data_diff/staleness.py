"""When a model's dev relation changed after its latest data diff finished (Pro, plan 06).

A diff compares what was built in dev at the time. A later successful run, build, clone, seed or
snapshot of the same node on the same target replaces that relation, so the result may no longer
hold. dbt clone reports an existing relation it kept as a "No-op" success, which changes nothing.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DataDiffSnapshot, InvocationModelResult, RunInvocation

REBUILDING_COMMANDS = frozenset({"run", "build", "clone", "seed", "snapshot"})
NO_OP_MESSAGE = "No-op"


@dataclass(frozen=True)
class NodeRebuild:
    unique_id: str
    target: str | None
    command: str
    completed_at: datetime


def _as_utc(value: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; they were stored as UTC."""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def rebuilt_after(snap: DataDiffSnapshot, rebuilds: Iterable[NodeRebuild]) -> NodeRebuild | None:
    """The newest rebuild of the snapshot's node on its dev target after the diff finished."""
    finished = _as_utc(snap.finished_at)
    if snap.status == "running" or finished is None:
        return None
    later = [
        r for r in rebuilds
        if r.unique_id == snap.unique_id
        and (snap.dev_target is None or r.target is None or r.target == snap.dev_target)
        and r.completed_at > finished
    ]
    return max(later, key=lambda r: r.completed_at, default=None)


async def load_rebuilds(session: AsyncSession, project_id: int, unique_ids: Sequence[str]) -> list[NodeRebuild]:
    """Successful node results that rewrote a relation, for these nodes (history keeps the last 20 per node)."""
    if not unique_ids:
        return []
    rows = (await session.execute(
        select(InvocationModelResult, RunInvocation)
        .join(RunInvocation, RunInvocation.id == InvocationModelResult.invocation_id)
        .where(
            InvocationModelResult.project_id == project_id,
            InvocationModelResult.unique_id.in_(list(unique_ids)),
            InvocationModelResult.status == "success",
            RunInvocation.command.in_(REBUILDING_COMMANDS),
        )
    )).all()
    rebuilds: list[NodeRebuild] = []
    for result, inv in rows:
        if (result.message or "").strip() == NO_OP_MESSAGE:
            continue
        completed = _as_utc(result.completed_at) or _as_utc(inv.finished_at)
        if completed is not None:
            rebuilds.append(NodeRebuild(result.unique_id, inv.target, inv.command, completed))
    return rebuilds
