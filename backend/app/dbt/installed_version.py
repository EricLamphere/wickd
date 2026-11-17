"""The dbt-core version installed in the dbt venv, cached so per-request callers (package
compatibility, health) don't spawn `dbt --version` every time.

Cached until the `dbt` entry script changes (pip rewrites it on reinstall) or for
CACHE_SECONDS. Never creates the venv (existing_bin), like the dbt-core status check.
"""
import asyncio
import time

from app.dbt.core_version import parse_dbt_version
from app.dbt.venv import existing_bin
from app.logging_setup import get_logger

log = get_logger(__name__)

CACHE_SECONDS = 600
TIMEOUT_SECONDS = 30.0

_cache: tuple[tuple[str, float], float, str | None] | None = None
_lock = asyncio.Lock()


def reset_cache() -> None:
    global _cache
    _cache = None


async def installed_dbt_version() -> str | None:
    global _cache
    dbt = existing_bin("dbt")
    if dbt is None:
        return None
    try:
        key = (str(dbt), dbt.stat().st_mtime)
    except OSError:
        return None
    async with _lock:
        if _cache is not None and _cache[0] == key and time.monotonic() - _cache[1] < CACHE_SECONDS:
            return _cache[2]
        try:
            proc = await asyncio.create_subprocess_exec(
                str(dbt), "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_SECONDS)
        except (OSError, TimeoutError) as exc:
            log.warning("dbt_version_failed", error=str(exc))
            return None
        version = parse_dbt_version(stdout.decode(errors="replace"))
        _cache = (key, time.monotonic(), version)
        return version
