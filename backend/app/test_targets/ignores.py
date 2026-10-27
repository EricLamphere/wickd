"""Test gaps the user chose not to test (Health → Test Gaps → Ignored).

Ignoring is per row (a column, or a column combination), by its key from
app/test_targets/batch.py row_key(): every suggested test for that row is
hidden, now and in later rankings, until it's unignored. The model name and
column label are stored so an ignored row can still be listed once the gap
itself is gone (tested since, or the column removed).
"""

from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import TestGapIgnore
from app.test_targets.batch import row_key


def row_label(row: dict) -> str:
    return row.get("column") or "(" + ", ".join(row.get("columns") or []) + ")"


async def ignored(session: AsyncSession, project_id: int) -> list[TestGapIgnore]:
    result = await session.execute(
        select(TestGapIgnore)
        .where(TestGapIgnore.project_id == project_id)
        .order_by(TestGapIgnore.created_at.desc(), TestGapIgnore.id.desc())
    )
    return list(result.scalars())


async def ignored_keys(session: AsyncSession, project_id: int) -> set[str]:
    result = await session.execute(select(TestGapIgnore.key).where(TestGapIgnore.project_id == project_id))
    return set(result.scalars())


async def ignore(session: AsyncSession, project_id: int, rows: Iterable[dict]) -> int:
    """Ignore these ranking rows (already-ignored ones are left as they are). Returns how many were added."""
    existing = await ignored_keys(session, project_id)
    added = 0
    for row in rows:
        key = row_key(row)
        if key in existing:
            continue
        existing.add(key)
        session.add(TestGapIgnore(
            project_id=project_id, key=key, unique_id=row["unique_id"], name=row["name"], label=row_label(row),
        ))
        added += 1
    await session.commit()
    return added


async def unignore(session: AsyncSession, project_id: int, keys: Iterable[str]) -> int:
    result = await session.execute(
        delete(TestGapIgnore).where(TestGapIgnore.project_id == project_id, TestGapIgnore.key.in_(list(keys)))
    )
    await session.commit()
    return result.rowcount or 0
