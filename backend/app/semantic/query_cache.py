"""Last result per metric query (table metric_query_results).

The key is (project, dbt target, env fingerprint, sql hash):

- the SQL hash changes whenever definitions do, because MetricFlow's SQL changes;
- the env fingerprint is a hash of the env vars wickd layers in (global → profile →
  project, incl. DBT_TARGET) plus the profiles.yml dbt reads, since a profile or a
  profiles.yml edit can repoint the same target name at another warehouse. Only the
  hash is stored, never the values. An unrelated var
  change costs a re-run; the reverse mistake would show prod numbers as dev.

Every warehouse result is written here. Reading it back is the caller's choice
(`CachePolicy` in query_service.py).
"""

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MetricQueryResult

# A dashboard needs several results per widget (current + previous, total + trend)
MAX_RESULTS_PER_PROJECT = 400


@dataclass(frozen=True)
class CacheKey:
    project_id: int
    target: str
    env_fingerprint: str
    sql_hash: str


@dataclass(frozen=True)
class CachedResult:
    columns: list[str]
    rows: list[list]
    truncated: bool
    ran_at: datetime
    elapsed_ms: int
    target: str
    profile_name: str | None


def sql_hash(sql: str) -> str:
    return hashlib.sha256(sql.strip().encode()).hexdigest()


def env_fingerprint(env_vars: Mapping[str, str]) -> str:
    return hashlib.sha256(json.dumps(sorted(env_vars.items())).encode()).hexdigest()


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


async def lookup(session: AsyncSession, key: CacheKey) -> CachedResult | None:
    row = (await session.execute(
        select(MetricQueryResult).where(
            MetricQueryResult.project_id == key.project_id,
            MetricQueryResult.target == key.target,
            MetricQueryResult.env_fingerprint == key.env_fingerprint,
            MetricQueryResult.sql_hash == key.sql_hash,
        )
    )).scalar_one_or_none()
    if row is None:
        return None
    try:
        columns, rows = json.loads(row.columns_json), json.loads(row.rows_json)
    except ValueError:
        return None
    return CachedResult(columns=columns, rows=rows, truncated=row.truncated, ran_at=_as_utc(row.ran_at),
                        elapsed_ms=row.elapsed_ms, target=row.target, profile_name=row.profile_name)


async def store(
    session: AsyncSession,
    key: CacheKey,
    *,
    columns: Sequence[str],
    rows: Sequence[Sequence],
    truncated: bool,
    ran_at: datetime,
    elapsed_ms: int,
    profile_name: str | None,
    metrics: Sequence[str],
    group_by: Sequence[str],
) -> None:
    """Upsert the result for `key`, then keep only the newest results for the project."""
    values = {
        "project_id": key.project_id, "target": key.target, "env_fingerprint": key.env_fingerprint,
        "sql_hash": key.sql_hash, "profile_name": profile_name, "metrics_json": json.dumps(list(metrics)),
        "group_by_json": json.dumps(list(group_by)), "columns_json": json.dumps(list(columns)),
        "rows_json": json.dumps([list(r) for r in rows], default=str), "truncated": truncated,
        "ran_at": ran_at, "elapsed_ms": elapsed_ms,
    }
    stmt = insert(MetricQueryResult).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["project_id", "target", "env_fingerprint", "sql_hash"],
        set_={k: stmt.excluded[k] for k in values if k not in ("project_id", "target", "env_fingerprint", "sql_hash")},
    )
    await session.execute(stmt)
    keep = (
        select(MetricQueryResult.id)
        .where(MetricQueryResult.project_id == key.project_id)
        .order_by(MetricQueryResult.ran_at.desc(), MetricQueryResult.id.desc())
        .limit(MAX_RESULTS_PER_PROJECT)
    )
    await session.execute(
        delete(MetricQueryResult).where(
            MetricQueryResult.project_id == key.project_id, MetricQueryResult.id.not_in(keep)
        )
    )
    await session.commit()
