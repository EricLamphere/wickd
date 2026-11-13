"""Shared hold of a project's dbt lock, for read-only commands that may overlap each other.

Metric query workers (`dbt show`, each with its own --target-path) can run side by side, but never
beside a `dbt run`, `deps` or anything else that takes the project's lock: the first holder
acquires the lock for the group, later ones join while the group has it, and the last one out
releases it. Commands that take the lock the usual way wait for the whole group.

A holder joins an active group even while an exclusive command waits, so a long series of
metric runs can delay it; each metric run is bounded (and cancellable), so it isn't starved.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager


class SharedGate:
    """Shared holds of one asyncio.Lock (see the module docstring)."""

    def __init__(self, lock: asyncio.Lock) -> None:
        self._lock = lock
        self._holders = 0
        self._acquiring: asyncio.Future[bool] | None = None

    @property
    def holders(self) -> int:
        return self._holders

    async def _acquire(self) -> None:
        while True:
            if self._holders > 0:
                self._holders += 1
                return
            if self._acquiring is None:
                await self._acquire_for_group()
                return
            # another holder is acquiring the lock for the group: wait for it, then join (or retry)
            await asyncio.shield(self._acquiring)

    async def _acquire_for_group(self) -> None:
        future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._acquiring = future
        try:
            await self._lock.acquire()
        except BaseException:
            self._acquiring = None
            future.set_result(False)
            raise
        self._holders = 1
        self._acquiring = None
        future.set_result(True)

    def _release(self) -> None:
        self._holders -= 1
        if self._holders == 0:
            self._lock.release()

    @asynccontextmanager
    async def hold(self, timeout: float | None = None) -> AsyncIterator[None]:
        """Hold the lock shared for the block; TimeoutError if it isn't free within `timeout`."""
        async with asyncio.timeout(timeout):
            await self._acquire()
        try:
            yield
        finally:
            self._release()
