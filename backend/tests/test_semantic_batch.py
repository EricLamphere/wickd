"""semantic/batch.py: parsing a batch's output and resuming after a failing statement."""

import json
from pathlib import Path

import pytest

from app.dbt.runner import runner
from app.semantic import batch
from app.semantic.batch import (
    BATCH_MARKER,
    build_batch_sql,
    error_detail,
    parse_batch_output,
    run_many,
)


def test_parse_batch_output_reads_markers_between_logs() -> None:
    text = "\n".join([
        "\x1b[0m12:13:05  Concurrency: 1 threads (target='dev')",
        f'{BATCH_MARKER}0:{{"columns": ["a", "d", "dt", "n"], "rows": [[1, 2.5, "2026-01-02", null]]}}',
        "12:13:05  some log line",
        f"{BATCH_MARKER}1:not json",
        f'{BATCH_MARKER}x:{{"columns": [], "rows": []}}',
        f'{BATCH_MARKER}2:{{"columns": ["a"], "rows": "nope"}}',
        f'{BATCH_MARKER}3:{{"columns": ["a"], "rows": []}}',
    ])
    assert parse_batch_output(text) == {0: (["a", "d", "dt", "n"], [[1, 2.5, "2026-01-02", None]]), 3: (["a"], [])}


def test_error_detail_keeps_dbts_message() -> None:
    text = "12:13:05  Running\n12:13:05  Encountered an error:\nRuntime Error\n  Catalog Error: nope_table"
    assert error_detail(text) == "Runtime Error\n  Catalog Error: nope_table"
    assert error_detail("") == "dbt show failed"


def test_build_batch_sql_limits_and_tags_each_statement() -> None:
    sql = build_batch_sql(["select 1 as a;", "select 2 as a"], start=5, limit=10)
    assert "limit 11" in sql and "loop.index0 + 5" in sql
    assert json.dumps("select * from (\nselect 1 as a\n) as wickd_metric_batch limit 11") in sql
    assert sql.rstrip().endswith("select 1 as wickd_batch")


@pytest.fixture
def fake_dbt(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """Each statement `select <n>` returns [[n]]; `select fail` ends the compile there."""
    batches: list[list[str]] = []

    async def fake_env(project_id):
        return {"DBT_TARGET": "dev"}

    async def fake_run(req):
        inline = req.extra[1]
        sqls = json.loads(inline.split("set wickd_sqls = ", 1)[1].split(" -%}", 1)[0])
        start = int(inline.split("loop.index0 + ", 1)[1].split(")", 1)[0])
        batches.append(sqls)
        lines = []
        for i, sql in enumerate(sqls):
            body = sql.split("\n")[1]
            if body == "select fail":
                lines.append("Encountered an error:\nDatabase Error: boom")
                return 1, "\n".join(lines).encode(), b""
            n = int(body.removeprefix("select "))
            rows = [[n]] * (3 if n == 3 else 1)
            lines.append(f"{BATCH_MARKER}{start + i}:{json.dumps({'columns': ['n'], 'rows': rows})}")
        return 0, "\n".join(lines).encode(), b""

    monkeypatch.setattr(batch, "load_project_env", fake_env)
    monkeypatch.setattr(runner, "run", fake_run)
    monkeypatch.setattr(runner, "is_project_busy", lambda project_id: False)
    return batches


async def test_run_many_continues_after_a_failing_statement(fake_dbt) -> None:
    sqls = ["select 1", "select fail", "select 3", "select {{ var('x') }}", "select 5"]
    results = await run_many(1, Path("/p"), sqls, limit=2)
    assert [r.error for r in results] == [None, "Database Error: boom", None, "Jinja isn't allowed in a batched query", None]
    assert results[0].rows == [[1]] and results[4].rows == [[5]]
    assert results[2].rows == [[3], [3]] and results[2].truncated is True
    assert len(fake_dbt) == 3  # [1, fail] → [3] → [5]: one start per failure + 1, skipping the Jinja one


async def test_run_many_marks_everything_when_dbt_stays_busy(fake_dbt, monkeypatch) -> None:
    monkeypatch.setattr(batch, "wait_for_lock", _never_free)
    results = await run_many(1, Path("/p"), ["select 1", "select 2"])
    assert all(r.error and "busy" in r.error for r in results) and fake_dbt == []


async def _never_free(project_id: int) -> bool:
    return False


async def test_another_target_parses_outside_the_project(fake_dbt, monkeypatch, tmp_path) -> None:
    """dbt show writes target/manifest.json for the target it runs on: a pinned or compared target
    mustn't leave the project's artifacts pointing at its relations."""
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    extras: list[tuple] = []
    real = runner.run

    async def recording(req):
        extras.append(req.extra)
        return await real(req)

    monkeypatch.setattr(runner, "run", recording)
    await run_many(4, Path("/p"), ["select 1"], target="prod")
    await run_many(4, Path("/p"), ["select 1"], target="dev")  # the active target (DBT_TARGET)
    await run_many(4, Path("/p"), ["select 1"])
    prod, dev, active = extras
    assert "--target-path" in prod and prod[prod.index("--target-path") + 1] == str(tmp_path / "targets" / "4" / "prod")
    assert "--target-path" not in dev and "--target-path" not in active

