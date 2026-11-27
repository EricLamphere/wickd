"""Recurring notes and seasonal monitors (plan 33)."""

from pathlib import Path

from app.semantic import note_seasons, notes


def _meta(**kw: object) -> notes.NoteMeta:
    return notes.validate_meta({"title": "t", "start": "2025-12-24", "end": "2025-12-26", "recurs": "yearly", **kw})


SERIES = [
    {"period": "2026-12-23", "value": 1.0, "suppressed": False},
    {"period": "2026-12-25", "value": 9.0, "suppressed": False},
    {"period": "2026-12-27", "value": 1.0, "suppressed": False},
]


def test_period_last_day() -> None:
    assert note_seasons.period_last_day("2026-12-07", "week") == "2026-12-13"
    assert note_seasons.period_last_day("2026-02-01", "month") == "2026-02-28"
    assert note_seasons.period_last_day("2026-02-03", "day") == "2026-02-03"


def test_seasonal_excludes_covered_periods_in_later_years() -> None:
    out = note_seasons.exclude_recurring(SERIES, [_meta()], algorithm="seasonal", metric="revenue", grain="day",
                                         dimension=None, slice_="")
    assert [p["suppressed"] for p in out] == [False, True, False]
    assert SERIES[1]["suppressed"] is False  # the input isn't changed


def test_other_algorithms_and_other_metrics_untouched() -> None:
    assert note_seasons.exclude_recurring(SERIES, [_meta()], algorithm="threshold", metric="revenue", grain="day",
                                          dimension=None, slice_="") is SERIES
    out = note_seasons.exclude_recurring(SERIES, [_meta(metric="orders")], algorithm="seasonal", metric="revenue",
                                         grain="day", dimension=None, slice_="")
    assert not any(p["suppressed"] for p in out)


def test_slice_must_match_the_notes_dimension_value() -> None:
    note = _meta(dimension="region", value="EU")
    kw = {"algorithm": "seasonal", "metric": "revenue", "grain": "week", "dimension": "order__region"}
    weekly = [{"period": "2026-12-21", "value": 9.0, "suppressed": False}]
    assert note_seasons.exclude_recurring(weekly, [note], slice_="EU", **kw)[0]["suppressed"] is True
    assert note_seasons.exclude_recurring(weekly, [note], slice_="US", **kw)[0]["suppressed"] is False


async def test_recurring_notes_reads_only_recurring(tmp_path: Path) -> None:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from app.db.models import Base

    folder = tmp_path / "wickd" / "notes"
    folder.mkdir(parents=True)
    (folder / "xmas.md").write_text("---\ntitle: Xmas\nstart: 2025-12-24\nend: 2025-12-26\nrecurs: yearly\n---\n")
    (folder / "once.md").write_text("---\ntitle: Once\nstart: 2025-12-24\nend: 2025-12-26\n---\n")
    (folder / "broken.md").write_text("nope")
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, class_=AsyncSession)() as session:
        got = await note_seasons.recurring_notes(session, 1, tmp_path)
    await engine.dispose()
    assert [m.title for m in got] == ["Xmas"]
