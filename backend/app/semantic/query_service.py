"""Run a metric query: validate → explain → cache lookup → one shared warehouse run → store.

- Every query is explained first (~5 ms in the sidecar); the compiled SQL is the
  cache key, so a YAML edit is a cache miss by construction (query_cache.py).
- `CachePolicy`: "refresh" always runs (the explorer's Run), "prefer" returns a
  cached result when there is one, "only" never touches the warehouse (previews).
- Identical queries in flight share one `dbt show`, and a run isn't cancelled when
  the client goes away: it's shielded, and the result is stored either way.
- The warehouse is always asked for MAX_ROW_LIMIT rows, so a cached result can serve
  any smaller `rows`.
"""

import asyncio
import hashlib
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import GlobalProfile, Project, ProjectEnvVar
from app.logging_setup import get_logger
from app.semantic import query_cache, service
from app.semantic.execute import MAX_ROW_LIMIT, run_sql
from app.semantic.query_cache import CacheKey
from app.semantic.query_spec import check_query, checked_sql

log = get_logger(__name__)

CachePolicy = Literal["refresh", "prefer", "only"]
ACTIVE_PROFILE_KEY = "active_global_profile_id"


@dataclass(frozen=True)
class QueryContext:
    target: str
    env_fingerprint: str
    profile_name: str | None


@dataclass(frozen=True)
class MetricQueryOutcome:
    sql: str
    sql_hash: str
    columns: list[str]
    rows: list[list]
    truncated: bool
    ran_at: datetime
    elapsed_ms: int
    target: str
    profile_name: str | None
    source: Literal["warehouse", "cache"]

    def limited(self, rows: int) -> "MetricQueryOutcome":
        if len(self.rows) <= rows:
            return self
        return replace(self, rows=self.rows[:rows], truncated=True)

    def to_dict(self) -> dict[str, Any]:
        return {
            "sql": self.sql, "sql_hash": self.sql_hash, "columns": self.columns, "rows": self.rows,
            "truncated": self.truncated, "ran_at": self.ran_at.isoformat(), "elapsed_ms": self.elapsed_ms,
            "target": self.target or None, "profile_name": self.profile_name, "source": self.source,
        }


_inflight: dict[CacheKey, asyncio.Task[MetricQueryOutcome]] = {}


def profiles_hash(project_path: Path, env: Mapping[str, str]) -> str:
    """sha256 of the profiles.yml dbt will read (DBT_PROFILES_DIR, project, ~/.dbt), '' if none.

    Editing a target in profiles.yml can point the same target name at another warehouse.
    """
    dirs = [Path(env["DBT_PROFILES_DIR"])] if env.get("DBT_PROFILES_DIR") else []
    for directory in [*dirs, project_path, Path.home() / ".dbt"]:
        try:
            return hashlib.sha256((directory / "profiles.yml").read_bytes()).hexdigest()
        except OSError:
            continue
    return ""


async def query_context(session: AsyncSession, project_id: int, project_path: Path) -> QueryContext:
    from app.api.init import project_env  # app.api.init imports half the app

    layered = await project_env(session, project_id, base={})
    env = await project_env(session, project_id, base=os.environ)
    target = env.get("DBT_TARGET") or ""
    fingerprint = {**layered, "DBT_TARGET": target, "wickd:profiles.yml": profiles_hash(project_path, env)}
    return QueryContext(
        target=target,
        env_fingerprint=query_cache.env_fingerprint(fingerprint),
        profile_name=await _active_profile_name(session, project_id),
    )


async def _active_profile_name(session: AsyncSession, project_id: int) -> str | None:
    raw = (await session.execute(
        select(ProjectEnvVar.value).where(ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == ACTIVE_PROFILE_KEY)
    )).scalar_one_or_none()
    if raw is None or not raw.isdigit():
        return None
    profile = await session.get(GlobalProfile, int(raw))
    return profile.name if profile is not None else None


async def explain_checked(project: Project, query: Mapping[str, Any], adapter_type: str | None) -> dict:
    """{sql, columns} after validating `query` against the catalog and the SQL itself."""
    path = Path(project.path)
    check_query(query, await service.catalog(path), adapter_type)
    explained = await service.explain(path, dict(query))
    return {**explained, "sql": checked_sql(explained["sql"], adapter_type)}


async def run_metric_query(
    session: AsyncSession,
    project: Project,
    query: Mapping[str, Any],
    adapter_type: str | None,
    *,
    rows: int = MAX_ROW_LIMIT,
    cache: CachePolicy = "refresh",
) -> MetricQueryOutcome | None:
    """The query's result (None only for cache="only" on a miss)."""
    explained = await explain_checked(project, query, adapter_type)
    sql = explained["sql"]
    ctx = await query_context(session, project.id, Path(project.path))
    key = CacheKey(project.id, ctx.target, ctx.env_fingerprint, query_cache.sql_hash(sql))
    if cache != "refresh":
        hit = await query_cache.lookup(session, key)
        if hit is not None:
            return MetricQueryOutcome(
                sql=sql, sql_hash=key.sql_hash, columns=hit.columns, rows=hit.rows, truncated=hit.truncated,
                ran_at=hit.ran_at, elapsed_ms=hit.elapsed_ms, target=hit.target, profile_name=hit.profile_name,
                source="cache",
            ).limited(rows)
        if cache == "only":
            return None
    task = _inflight.get(key)
    if task is None:
        task = asyncio.create_task(_run_and_store(project, key, sql, adapter_type, ctx, query))
        _inflight[key] = task
        task.add_done_callback(lambda t: _finished(key, t))
    return (await asyncio.shield(task)).limited(rows)


def _finished(key: CacheKey, task: asyncio.Task[MetricQueryOutcome]) -> None:
    """Forget the in-flight run; log its failure (its requester may have gone away)."""
    _inflight.pop(key, None)
    if task.cancelled():
        return
    exc = task.exception()  # also marks it retrieved
    if exc is not None:
        log.warning("metric_query_failed", project_id=key.project_id, sql_hash=key.sql_hash[:12], error=repr(exc)[:500])


async def _run_and_store(
    project: Project, key: CacheKey, sql: str, adapter_type: str | None, ctx: QueryContext, query: Mapping[str, Any]
) -> MetricQueryOutcome:
    from app.db.engine import SessionLocal  # the request's session may be gone when this finishes

    started = time.monotonic()
    result = await run_sql(project.id, Path(project.path), sql, adapter_type, limit=MAX_ROW_LIMIT)
    outcome = MetricQueryOutcome(
        sql=sql, sql_hash=key.sql_hash, columns=result.columns, rows=result.rows, truncated=result.truncated,
        ran_at=datetime.now(UTC), elapsed_ms=int((time.monotonic() - started) * 1000), target=ctx.target,
        profile_name=ctx.profile_name, source="warehouse",
    )
    try:
        async with SessionLocal() as session:
            await query_cache.store(
                session, key, columns=outcome.columns, rows=outcome.rows, truncated=outcome.truncated,
                ran_at=outcome.ran_at, elapsed_ms=outcome.elapsed_ms, profile_name=outcome.profile_name,
                metrics=list(query.get("metrics") or []), group_by=list(query.get("group_by") or []),
            )
    except Exception:  # a failed cache write shouldn't lose the user's result
        log.exception("metric_query_cache_store_failed", project_id=project.id)
    return outcome
