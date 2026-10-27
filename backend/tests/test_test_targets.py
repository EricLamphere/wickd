"""app/test_targets: candidates → test items, YAML rendering, row keys, loading a
model's ranking for test generation, and the join_keys_json migration."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import engine as db_engine
from app.db import migrations
from app.db.models import Base, ColumnLineageSnapshot, Project
from app.test_targets import pro, service
from app.test_targets.batch import row_key
from app.test_targets.items import render_tests, structural_tests, suggestion_key

UID = "model.proj.orders"
ROWS = [
    {"unique_id": UID, "column": "ID", "candidates": [
        {"test": "unique", "evidence": "one row per `id`"},
        {"test": "relationships", "to": "model.proj.c", "field": "id", "evidence": "joined to `c.id` in 1 model"},
    ]},
    {"unique_id": UID, "column": None, "columns": ["id", "day"], "candidates": [
        {"test": "unique_combination_of_columns", "combination": ["ID", "day"], "evidence": "one row per (id, day)"},
    ]},
    {"unique_id": UID, "column": "missing", "candidates": [{"test": "not_null", "evidence": "x"}]},
]


def test_structural_tests_match_real_columns():
    tests = structural_tests(ROWS, ["id", "day"])
    assert tests == [
        {"reason": "one row per `id`", "evidence": "one row per `id`", "source": "lineage", "column": "id",
         "test": "unique"},
        {"reason": "joined to `c.id` in 1 model", "evidence": "joined to `c.id` in 1 model", "source": "lineage",
         "column": "id", "test": "relationships", "to": "model.proj.c", "field": "id"},
        {"reason": "one row per (id, day)", "evidence": "one row per (id, day)", "source": "lineage",
         "column": None, "columns": ["id", "day"], "test": "unique_combination_of_columns"},
    ]
    # without a column list (batch), names are used as given
    assert [t["column"] for t in structural_tests(ROWS)] == ["ID", "ID", None, "missing"]


def test_suggestion_and_row_keys():
    assert suggestion_key({"column": "ID", "test": "unique"}) == ("id", "unique")
    assert suggestion_key({"column": None, "columns": ["A", "b"], "test": "x"}) == ("(a, b)", "x")
    assert row_key(ROWS[0]) == f"{UID}::ID"
    assert row_key(ROWS[1]) == f"{UID}::(id, day)"


def test_render_tests_new_file_with_column_and_model_tests():
    tests = [
        {"column": "id", "spec": {"name": "not_null", "args": {}}},
        {"column": None, "spec": {"name": "dbt_utils.unique_combination_of_columns",
                                  "args": {"combination_of_columns": ["id", "day"]}}},
    ]
    out = yaml.safe_load(render_tests(None, "schema.yml", "models", "orders", tests, "1.9.0"))
    model = out["models"][0]
    assert model["columns"] == [{"name": "id", "data_tests": ["not_null"]}]
    assert model["data_tests"] == [
        {"dbt_utils.unique_combination_of_columns": {"combination_of_columns": ["id", "day"]}},
    ]


# ── targets_for_model ────────────────────────────────────────────────────────


@pytest.fixture
async def db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 't.sqlite'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    monkeypatch.setattr(db_engine, "SessionLocal", factory)
    monkeypatch.setattr(migrations, "SessionLocal", factory)
    yield factory
    await engine.dispose()


async def _project(db, tmp_path: Path, version: int | None) -> tuple[int, Path]:
    root = tmp_path / "proj"
    (root / "target").mkdir(parents=True)
    (root / "target" / "manifest.json").write_text(json.dumps({"nodes": {}}))
    async with db() as session:
        project = Project(name="proj", path=str(root), platform="local")
        session.add(project)
        await session.commit()
        if version is not None:
            session.add(ColumnLineageSnapshot(
                project_id=project.id, status="done", lineage_version=version,
                results_json=json.dumps({UID: {"id": []}}),
                join_keys_json=json.dumps({UID: {"join_pairs": [], "grain": None}}),
            ))
            await session.commit()
        return project.id, root


async def test_targets_for_model_ranks_one_model(db, tmp_path, monkeypatch):
    seen: dict = {}

    def rank(manifest, lineage, row_deps, structure, unique_ids=None):
        seen.update(lineage=lineage, structure=structure, unique_ids=unique_ids)
        return ROWS

    monkeypatch.setattr(pro, "_pro", lambda: SimpleNamespace(rank_test_targets=rank))
    pid, root = await _project(db, tmp_path, 4)
    assert await service.targets_for_model(pid, root, UID) == ROWS
    assert seen == {"lineage": {UID: {"id": []}}, "structure": {UID: {"join_pairs": [], "grain": None}},
                    "unique_ids": [UID]}


@pytest.mark.parametrize("version", [None, 3])
async def test_targets_for_model_is_none_until_lineage_has_structure(db, tmp_path, monkeypatch, version):
    monkeypatch.setattr(pro, "_pro", lambda: SimpleNamespace(rank_test_targets=lambda *a: ROWS))
    pid, root = await _project(db, tmp_path, version)
    assert await service.targets_for_model(pid, root, UID) is None


async def test_targets_for_model_is_none_without_pro(db, tmp_path, monkeypatch):
    def _missing():
        raise pro.TestTargetsUnavailable("missing")

    monkeypatch.setattr(pro, "_pro", _missing)
    pid, root = await _project(db, tmp_path, 4)
    assert await service.targets_for_model(pid, root, UID) is None


async def test_migration_adds_join_keys_json(db, monkeypatch):
    async def _noop() -> None:
        return None

    monkeypatch.setattr(migrations, "ensure_db_initialized", _noop)
    async with db() as session:
        await session.execute(text("DROP TABLE column_lineage_snapshots"))
        await session.execute(text(
            "CREATE TABLE column_lineage_snapshots (id INTEGER PRIMARY KEY, project_id INTEGER, status TEXT,"
            " started_at DATETIME, finished_at DATETIME, total_models INTEGER, checked_models INTEGER,"
            " results_json TEXT, error_message TEXT, manifest_mtime REAL)"
        ))
        await session.execute(text("INSERT INTO column_lineage_snapshots (id, status) VALUES (1, 'done')"))
        await session.commit()

    await migrations.run_migrations()
    await migrations.run_migrations()  # idempotent

    async with db() as session:
        row = (await session.execute(text(
            "SELECT join_keys_json, lineage_version FROM column_lineage_snapshots"
        ))).one()
    assert tuple(row) == ("{}", 1)


async def test_migration_creates_test_gap_ignores(db, monkeypatch):
    async def _noop() -> None:
        return None

    monkeypatch.setattr(migrations, "ensure_db_initialized", _noop)
    async with db() as session:
        await session.execute(text("DROP TABLE test_gap_ignores"))
        await session.commit()
    await migrations.run_migrations()
    await migrations.run_migrations()  # idempotent
    async with db() as session:
        await session.execute(text(
            "INSERT INTO test_gap_ignores (project_id, key, unique_id, name, label) VALUES (1, 'k', 'u', 'n', 'c')"
        ))
        await session.commit()
        assert (await session.execute(text("SELECT key FROM test_gap_ignores"))).scalar_one() == "k"
