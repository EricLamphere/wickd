"""semantic/batch.py: parsing a batch's output, resuming after a failing statement, parallel
workers, the startup and per-query clocks, and Cancel."""

import asyncio
import json
from pathlib import Path

import pytest

from app.dbt.runner import runner
from app.events.bus import bus
from app.semantic import batch, query_control, show_slots
from app.semantic.batch import (
    BATCH_MARKER,
    START_MARKER,
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


def test_error_detail_strips_colours_and_keeps_the_specific_error() -> None:
    text = ("\x1b[0m18:25:21  Running with dbt=1.10.13\n"
            "\x1b[0m18:25:21  Error while parsing node: inline_query\n  depends on a node named 'nope' which was not found\n"
            "\x1b[0m18:25:21  Encountered an error:\nError parsing inline query")
    assert error_detail(text) == ("Error while parsing node: inline_query\ndepends on a node named 'nope' which was not found\n"
                                  "Error parsing inline query")


def test_build_batch_sql_limits_and_tags_each_statement() -> None:
    sql = build_batch_sql(["select 1 as a;", "select 2 as a"], [5, 9], limit=10)
    assert "limit 11" in sql and "set wickd_idx = [5, 9]" in sql and START_MARKER in sql
    assert json.dumps("select * from (\nselect 1 as a\n) as wickd_metric_batch limit 11") in sql
    assert sql.rstrip().endswith("select 1 as wickd_batch")


class FakeDbt:
    """Each statement `select <n>` returns [[n]]; `select fail` ends the compile there;
    `select hang` never answers; `select nostart` makes dbt hang before parsing finishes.
    Output is streamed line by line, like runner.run_lines()."""

    def __init__(self) -> None:
        self.batches: list[list[str]] = []
        self.extras: list[tuple] = []
        self.running = 0
        self.max_running = 0
        self.closed = 0

    async def run_lines(self, req, *, locked: bool = True):
        assert locked is False  # workers run inside runner.shared_lock()
        inline = req.extra[1]
        sqls = json.loads(inline.split("set wickd_sqls = ", 1)[1].split(" -%}", 1)[0])
        indices = json.loads(inline.split("set wickd_idx = ", 1)[1].split(" -%}", 1)[0])
        bodies = [sql.split("\n")[1] for sql in sqls]
        self.batches.append(bodies)
        self.extras.append(req.extra)
        self.running += 1
        self.max_running = max(self.max_running, self.running)
        try:
            yield "12:00:00  Running with dbt=1.10.13"
            if "select nostart" in bodies:
                await asyncio.sleep(3600)
            yield START_MARKER
            for index, body in zip(indices, bodies, strict=True):
                await asyncio.sleep(0.01)
                if body == "select fail":
                    yield "Encountered an error:"
                    yield "Database Error: boom"
                    return
                if body == "select hang":
                    await asyncio.sleep(3600)
                n = int(body.removeprefix("select "))
                rows = [[n]] * (3 if n == 3 else 1)
                yield f"{BATCH_MARKER}{index}:{json.dumps({'columns': ['n'], 'rows': rows})}"
        finally:
            self.running -= 1
            self.closed += 1


@pytest.fixture
def env() -> dict[str, str]:
    return {"DBT_TARGET": "dev", "METRIC_QUERY_CONCURRENCY": "1"}


@pytest.fixture
def fake_dbt(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, env: dict[str, str]) -> FakeDbt:
    from app.config import settings

    dbt = FakeDbt()

    async def fake_env(project_id):
        return dict(env)

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(batch, "load_project_env", fake_env)
    monkeypatch.setattr(runner, "run_lines", dbt.run_lines)
    monkeypatch.setattr(batch, "STARTUP_ALLOWANCE_S", 0.3)
    monkeypatch.setattr(batch, "query_timeout", lambda env: 0.3)
    show_slots._pools.clear()
    yield dbt
    show_slots._pools.clear()


def _bodies(dbt: FakeDbt) -> list[list[str]]:
    return [[b.removeprefix("select ") for b in batch_] for batch_ in dbt.batches]


async def test_run_many_continues_after_a_failing_statement(fake_dbt) -> None:
    sqls = ["select 1", "select fail", "select 3", "select {{ var('x') }}", "select 5"]
    results = await run_many(1, Path("/p"), sqls, limit=2)
    assert [r.error for r in results] == [None, "Database Error: boom", None, "Jinja isn't allowed in a batched query", None]
    assert results[0].rows == [[1]] and results[4].rows == [[5]]
    assert results[2].rows == [[3], [3]] and results[2].truncated is True
    assert _bodies(fake_dbt) == [["1", "fail", "3", "5"], ["3", "5"]]  # one start per failure + 1


async def test_run_many_marks_everything_when_dbt_stays_busy(fake_dbt) -> None:
    lock = runner._lock_for(1)
    await lock.acquire()
    try:
        results = await run_many(1, Path("/p"), ["select 1", "select 2"], lock_wait=0.05)
    finally:
        lock.release()
    assert all(r.error and "busy" in r.error for r in results) and fake_dbt.batches == []


async def test_every_run_writes_its_artifacts_outside_the_project(fake_dbt, tmp_path) -> None:
    """dbt show writes manifest.json for the target it runs on: neither a pinned target nor the
    active one may rewrite the project's target/ (the semantic layer and the DAG read it)."""
    await run_many(4, Path("/p"), ["select 1"], target="prod")
    await run_many(4, Path("/p"), ["select 1"])
    prod, active = fake_dbt.extras
    assert prod[prod.index("--target-path") + 1] == str(tmp_path / "show" / "4" / "prod" / "w0")
    assert active[active.index("--target-path") + 1] == str(tmp_path / "show" / "4" / "dev" / "w0")
    assert prod[prod.index("--target") + 1] == "prod" and active[active.index("--target") + 1] == "dev"


async def test_a_slow_query_times_out_alone_and_keeps_the_finished_ones(fake_dbt) -> None:
    """The timeout is per query: results printed before it are kept, and the rest still run."""
    results = await run_many(1, Path("/p"), ["select 1", "select 2", "select hang", "select 4"])
    assert [r.rows for r in results] == [[[1]], [[2]], [], [[4]]]
    assert results[2].error and "Query 3 of 4" in results[2].error and "METRIC_QUERY_TIMEOUT" in results[2].error
    assert len(fake_dbt.batches) == 2  # [1, 2, hang, 4] → [4]


async def test_slow_queries_never_stop_the_rest(fake_dbt) -> None:
    """Every query gets its turn, however many before it timed out."""
    results = await run_many(1, Path("/p"), ["select hang", "select hang", "select hang", "select 4"])
    assert [bool(r.error) for r in results] == [True, True, True, False] and results[3].rows == [[4]]


async def test_a_slow_start_is_retried_once_then_reported(fake_dbt) -> None:
    results = await run_many(1, Path("/p"), ["select nostart", "select 2"])
    assert all(r.error and "didn't finish starting" in r.error for r in results)
    assert len(fake_dbt.batches) == batch.STARTUP_ATTEMPTS


async def test_queries_are_dealt_to_parallel_workers(fake_dbt, env) -> None:
    env["METRIC_QUERY_CONCURRENCY"] = "2"
    seen: list[int] = []

    async def on_result(index, result):
        seen.append(index)

    results = await run_many(1, Path("/p"), [f"select {n}" for n in (1, 2, 4, 5, 6)], on_result=on_result)
    assert [r.rows for r in results] == [[[1]], [[2]], [[4]], [[5]], [[6]]]
    assert sorted(_bodies(fake_dbt)) == [["1", "4", "6"], ["2", "5"]]  # round-robin: the top ones first
    assert fake_dbt.max_running == 2 and sorted(seen) == [0, 1, 2, 3, 4]
    w0, w1 = (extra[extra.index("--target-path") + 1] for extra in fake_dbt.extras)
    assert w0 != w1  # each worker its own target path


async def test_two_runs_share_the_projects_slots(fake_dbt, env) -> None:
    env["METRIC_QUERY_CONCURRENCY"] = "2"
    await asyncio.gather(
        run_many(1, Path("/p"), ["select 1", "select 2", "select 4"]),
        run_many(1, Path("/p"), ["select 5", "select 6", "select 7"]),
    )
    assert fake_dbt.max_running == 2


async def test_cancel_stops_dbt_and_keeps_finished_results(fake_dbt) -> None:
    events = await bus.subscribe("project:7")
    try:
        async def cancel_after_first(index, result):
            assert query_control.cancel(7) == 1

        results = await run_many(7, Path("/p"), ["select 1", "select hang", "select 3"], kind="metrics",
                                 on_result=cancel_after_first)
        assert results[0].rows == [[1]] and not results[0].cancelled
        assert results[1].cancelled and results[2].cancelled and results[1].error
        assert fake_dbt.running == 0 and fake_dbt.closed == 1
        assert query_control.active(7) == []
        progress = []
        while not events.empty():
            event = events.get_nowait()
            if event.type == query_control.PROGRESS_EVENT:
                progress.append(event.data)
        assert progress[0]["total"] == 3 and progress[-1]["finished"] and progress[-1]["cancelled"]
    finally:
        await bus.unsubscribe("project:7", events)


async def test_runs_without_a_kind_arent_cancellable_from_the_metrics_page(fake_dbt) -> None:
    results = await run_many(8, Path("/p"), ["select 1"])
    assert query_control.cancel(8) == 0 and results[0].rows == [[1]]


def test_concurrency_setting() -> None:
    assert show_slots.query_concurrency({}, "athena") == show_slots.DEFAULT_CONCURRENCY
    assert show_slots.query_concurrency({"METRIC_QUERY_CONCURRENCY": "8"}, "athena") == 8
    assert show_slots.query_concurrency({"METRIC_QUERY_CONCURRENCY": "99"}, None) == show_slots.MAX_CONCURRENCY
    for bad in ("", "x", "0", "-2"):
        assert show_slots.query_concurrency({"METRIC_QUERY_CONCURRENCY": bad}, None) == show_slots.DEFAULT_CONCURRENCY
    assert show_slots.query_concurrency({"METRIC_QUERY_CONCURRENCY": "8"}, "duckdb") == 1  # one process per file


def test_seed_partial_parse_copies_only_a_newer_file(tmp_path) -> None:
    import os

    src, dest = tmp_path / "target", tmp_path / "slot"
    src.mkdir()
    show_slots.seed_partial_parse(src, dest)
    assert not dest.exists()
    (src / show_slots.PARTIAL_PARSE).write_bytes(b"v1")
    show_slots.seed_partial_parse(src, dest)
    assert (dest / show_slots.PARTIAL_PARSE).read_bytes() == b"v1"
    (dest / show_slots.PARTIAL_PARSE).write_bytes(b"slot's own, newer")
    os.utime(src / show_slots.PARTIAL_PARSE, (1, 1))
    show_slots.seed_partial_parse(src, dest)
    assert (dest / show_slots.PARTIAL_PARSE).read_bytes() == b"slot's own, newer"


def test_query_timeout_reads_the_project_setting() -> None:
    assert batch.query_timeout({}) == batch.DEFAULT_QUERY_TIMEOUT_S
    assert batch.query_timeout({"METRIC_QUERY_TIMEOUT": "300"}) == 300
    assert batch.query_timeout({"METRIC_QUERY_TIMEOUT": " 45 "}) == 45
    for bad in ("", "abc", "-5", "0"):
        assert batch.query_timeout({"METRIC_QUERY_TIMEOUT": bad}) == batch.DEFAULT_QUERY_TIMEOUT_S
    assert batch.query_timeout({"METRIC_QUERY_TIMEOUT": "999999"}) == batch.MAX_QUERY_TIMEOUT_S
