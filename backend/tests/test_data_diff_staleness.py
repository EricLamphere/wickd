"""A data diff is flagged when its dev relation was rebuilt after it finished (plan 06)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.data_diff.staleness import NodeRebuild, load_rebuilds, rebuilt_after
from app.db.models import Base, DataDiffSnapshot, InvocationModelResult, Project, RunInvocation

UID = "model.proj.orders"
T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)


def _snap(**kw) -> DataDiffSnapshot:
    base = {"unique_id": UID, "name": "orders", "status": "done", "dev_target": "dev", "finished_at": T0}
    return DataDiffSnapshot(**{**base, **kw})


def _rebuild(minutes: int, target: str | None = "dev", uid: str = UID, command: str = "clone") -> NodeRebuild:
    return NodeRebuild(uid, target, command, T0 + timedelta(minutes=minutes))


def test_newest_later_rebuild_on_the_dev_target() -> None:
    got = rebuilt_after(_snap(), [_rebuild(-5), _rebuild(3, command="run"), _rebuild(7), _rebuild(9, target="prod")])
    assert got is not None and got.completed_at == T0 + timedelta(minutes=7) and got.command == "clone"


def test_nothing_after_other_nodes_or_while_running() -> None:
    assert rebuilt_after(_snap(), [_rebuild(-1), _rebuild(5, uid="model.proj.other")]) is None
    assert rebuilt_after(_snap(status="running", finished_at=None), [_rebuild(5)]) is None


def test_naive_finish_time_is_utc() -> None:
    assert rebuilt_after(_snap(finished_at=T0.replace(tzinfo=None)), [_rebuild(1)]) is not None


async def test_load_rebuilds_keeps_successful_relation_writes() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)() as session:
        project = Project(name="proj", path="/tmp/proj")
        session.add(project)
        await session.commit()
        rows = [("clone", "success", None), ("clone", "success", "No-op"), ("test", "success", None),
                ("run", "error", None), ("build", "success", "OK")]
        for i, (command, status, message) in enumerate(rows):
            inv = RunInvocation(project_id=project.id, command=command, status="success", target="dev")
            session.add(inv)
            await session.flush()
            session.add(InvocationModelResult(
                invocation_id=inv.id, project_id=project.id, unique_id=UID, name="orders", kind="model",
                status=status, message=message, completed_at=T0 + timedelta(minutes=i),
            ))
        await session.commit()
        got = await load_rebuilds(session, project.id, [UID])
    await engine.dispose()
    assert sorted((r.command, r.completed_at) for r in got) == [
        ("build", T0 + timedelta(minutes=4)), ("clone", T0)]
