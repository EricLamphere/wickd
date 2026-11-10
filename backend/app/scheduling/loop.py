"""One ticker for every scheduler (metric monitors, scheduled runs).

Schedulers `register(name, tick_fn)` at import; `start()` / `stop()` run from the app
lifespan. Every TICK_S the loop calls each tick fn with the current (aware UTC) time;
one failing never stops the others.
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from app.logging_setup import get_logger

log = get_logger(__name__)

TICK_S = 60

TickFn = Callable[[datetime], Awaitable[object]]

_ticks: dict[str, TickFn] = {}
_task: asyncio.Task | None = None


def register(name: str, tick_fn: TickFn) -> None:
    """Add (or replace) a scheduler's tick fn."""
    _ticks[name] = tick_fn


def registered() -> list[str]:
    return list(_ticks)


async def tick_all(now: datetime) -> None:
    """Run every registered tick fn once, isolating failures."""
    for name, fn in list(_ticks.items()):
        try:
            await fn(now)
        except Exception:
            log.exception("scheduler_tick_failed", scheduler=name)


async def _run() -> None:
    while True:
        await asyncio.sleep(TICK_S)
        await tick_all(datetime.now(UTC))


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_run())


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
