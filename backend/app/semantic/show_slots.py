"""Worker slots for metric `dbt show`s: how many run at once per project, and where each writes.

A slot is one dbt process. Each slot has its own --target-path under the data dir, so parallel
`dbt show`s never write the same manifest.json / partial_parse.msgpack, and none of them rewrite
the project's own target/ (which the semantic layer and the DAG read). A slot's folder starts
with a copy of the project's partial_parse.msgpack, so its first parse is a partial one too.

All of a project's metric runs share its slots (METRIC_QUERY_CONCURRENCY, default 4), so two
runs at once (Run all, then a dashboard) share the warehouse instead of doubling the load.
DuckDB and SQLite allow one process per database file, so they always get one slot.
"""

import asyncio
import re
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.logging_setup import get_logger

log = get_logger(__name__)

CONCURRENCY_KEY = "METRIC_QUERY_CONCURRENCY"
DEFAULT_CONCURRENCY = 4
MAX_CONCURRENCY = 16
SINGLE_PROCESS_ADAPTERS = frozenset({"duckdb", "sqlite"})
PARTIAL_PARSE = "partial_parse.msgpack"


def query_concurrency(env: dict[str, str], adapter_type: str | None) -> int:
    """How many metric `dbt show`s a project runs at once (METRIC_QUERY_CONCURRENCY, 1–16)."""
    if (adapter_type or "").lower() in SINGLE_PROCESS_ADAPTERS:
        return 1
    raw = (env.get(CONCURRENCY_KEY) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_CONCURRENCY
    return min(value, MAX_CONCURRENCY) if value > 0 else DEFAULT_CONCURRENCY


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name) or "_"


def slot_target_path(project_id: int, target: str | None, slot: int) -> Path:
    """Slot `slot`'s --target-path for `target` (None = the profile's default target)."""
    return settings.data_dir / "show" / str(project_id) / _safe(target or "_default") / f"w{slot}"


def seed_partial_parse(source_target: Path, dest: Path) -> None:
    """Copy the project's partial_parse.msgpack into a slot folder when it's newer than the slot's."""
    src = source_target / PARTIAL_PARSE
    out = dest / PARTIAL_PARSE
    try:
        if not src.is_file():
            return
        if out.is_file() and out.stat().st_mtime >= src.stat().st_mtime:
            return
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out)
    except OSError as exc:  # only an optimization: dbt parses from scratch without it
        log.info("show_slot_seed_failed", source=str(src), dest=str(dest), error=str(exc))


@dataclass
class _Pool:
    size: int
    free: asyncio.Queue[int]
    in_use: int = 0


_pools: dict[int, _Pool] = {}


def _pool(project_id: int, size: int) -> _Pool:
    pool = _pools.get(project_id)
    # a changed setting applies once the project's slots are all free
    if pool is None or (pool.size != size and pool.in_use == 0):
        free: asyncio.Queue[int] = asyncio.Queue()
        for slot in range(size):
            free.put_nowait(slot)
        pool = _Pool(size, free)
        _pools[project_id] = pool
    return pool


def pool_size(project_id: int, size: int) -> int:
    """The number of slots the project's runs share right now."""
    return _pool(project_id, size).size


@asynccontextmanager
async def slot(project_id: int, size: int) -> AsyncIterator[int]:
    """A free slot id for one dbt process (waits for one)."""
    pool = _pool(project_id, size)
    slot_id = await pool.free.get()
    pool.in_use += 1
    try:
        yield slot_id
    finally:
        pool.in_use -= 1
        pool.free.put_nowait(slot_id)
