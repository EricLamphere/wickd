"""runner.shared_lock(): read-only holders overlap each other, exclusive commands wait for all of them."""

import asyncio

import pytest

from app.dbt.runner import runner


async def test_holders_overlap_and_exclusive_waits_for_the_last_one() -> None:
    lock = runner._lock_for(951)
    order: list[str] = []
    first_in = asyncio.Event()
    release = asyncio.Event()

    async def holder(name: str) -> None:
        async with runner.shared_lock(951):
            order.append(f"{name} in")
            first_in.set()
            await release.wait()
        order.append(f"{name} out")

    async def exclusive() -> None:
        await first_in.wait()
        async with lock:
            order.append("exclusive")

    tasks = [asyncio.create_task(holder("a")), asyncio.create_task(exclusive()), asyncio.create_task(holder("b"))]
    await asyncio.sleep(0.05)
    assert order == ["a in", "b in"] and runner.is_project_busy(951)
    release.set()
    await asyncio.gather(*tasks)
    assert order[-1] == "exclusive" and not lock.locked()


async def test_shared_hold_times_out_behind_an_exclusive_command() -> None:
    lock = runner._lock_for(952)
    await lock.acquire()
    try:
        with pytest.raises(TimeoutError):
            async with runner.shared_lock(952, timeout=0.05):
                pass
    finally:
        lock.release()
    async with runner.shared_lock(952, timeout=0.05):  # free again: a failed wait leaves no trace
        assert lock.locked()
    assert not lock.locked()
