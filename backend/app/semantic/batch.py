"""Run many MetricFlow queries with a few `dbt show`s in parallel (metric pages, dashboards, monitors).

dbt's startup dominates a quick query, so each worker runs a series of queries in one
invocation: inline Jinja prints `WICKD_METRIC_BATCH_START` once the project is parsed, then
calls `run_query()` per statement and prints `WICKD_METRIC_BATCH:<i>:<json>` right after each
one (the same trick as dbt/probe.py's column batch). Jinja can't catch a failing statement, so
it ends the compile: statements before it have already printed, the one that didn't is the
failure, and the worker carries on with the rest in a new `dbt show`.

Warehouses with a fixed cost per query (Athena) are slow one query at a time, so the queries are
dealt round-robin to METRIC_QUERY_CONCURRENCY workers (show_slots.py: each its own dbt process and
--target-path, shared by every run of the project). Workers hold the project's dbt lock shared
(runner.shared_lock): they overlap each other but never a `dbt run`.

Two clocks: dbt gets STARTUP_ALLOWANCE_S to parse the project (a worker retries a slow start
once), then each query METRIC_QUERY_TIMEOUT seconds from the previous one's result. A query that
times out fails alone; the rest still run. Results go to `on_result` as they arrive, and a run
with a `kind` shows its progress and can be cancelled (query_control.py): finished results are
kept, the rest come back `cancelled`.

Values go through Jinja first: numbers stay numbers (decimals become floats), nulls
and booleans stay, anything else (dates, timestamps) becomes its string form.
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import aclosing, suppress
from dataclasses import dataclass, field
from pathlib import Path

from app.api.init import load_project_env
from app.config import settings
from app.dbt.runner import RunRequest, runner
from app.logging_setup import get_logger
from app.semantic import query_control, service, show_slots
from app.semantic.execute import LOCK_WAIT_S, MAX_ROW_LIMIT, error_detail, timeout_message

__all__ = ["BATCH_MARKER", "BatchResult", "build_batch_sql", "error_detail", "parse_batch_output", "query_timeout",
           "run_many"]

log = get_logger(__name__)

BATCH_MARKER = "WICKD_METRIC_BATCH:"
START_MARKER = "WICKD_METRIC_BATCH_START"
# Each query gets METRIC_QUERY_TIMEOUT seconds (a project setting) from the previous one's result.
TIMEOUT_KEY = "METRIC_QUERY_TIMEOUT"
DEFAULT_QUERY_TIMEOUT_S = 120
MAX_QUERY_TIMEOUT_S = 3600
# dbt's own start (parsing the project) before the first query; a slow start is retried once
STARTUP_ALLOWANCE_S = 300.0
STARTUP_ATTEMPTS = 2
CANCELLED = "Cancelled before it ran."
_JINJA_TOKENS = ("{{", "}}", "{%", "%}", "{#", "#}")

_ROW_JINJA = (
    "{%- set out = [] -%}"
    "{%- for row in res.rows -%}{%- set vals = [] -%}"
    "{%- for v in row.values() -%}"
    "{%- if v is none -%}{%- do vals.append(none) -%}"
    "{%- elif v is boolean -%}{%- do vals.append(v) -%}"
    "{%- elif v is number -%}{%- do vals.append(v | int if v == (v | int) else v | float) -%}"
    "{%- else -%}{%- do vals.append(v | string) -%}{%- endif -%}"
    "{%- endfor -%}{%- do out.append(vals) -%}{%- endfor -%}"
)


@dataclass(frozen=True)
class BatchResult:
    columns: list[str]
    rows: list[list]
    truncated: bool
    error: str | None = None
    cancelled: bool = False  # never ran: the run was cancelled first (`error` says so)


OnResult = Callable[[int, BatchResult], Awaitable[None]]


def _limited(sql: str, limit: int) -> str:
    return f"select * from (\n{sql.strip().rstrip(';')}\n) as wickd_metric_batch limit {limit + 1}"


def build_batch_sql(sqls: list[str], indices: list[int], limit: int) -> str:
    """Inline Jinja running `sqls` in order, printing each result tagged with its index in `indices`."""
    return (
        "{%- if execute -%}\n"
        f"{{%- do print('{START_MARKER}') -%}}\n"
        f"{{%- set wickd_sqls = {json.dumps([_limited(s, limit) for s in sqls])} -%}}\n"
        f"{{%- set wickd_idx = {json.dumps(indices)} -%}}\n"
        "{%- for q in wickd_sqls -%}\n"
        "{%- set res = run_query(q) -%}\n"
        f"{_ROW_JINJA}\n"
        f"{{%- do print('{BATCH_MARKER}' ~ wickd_idx[loop.index0] ~ ':' ~ "
        "tojson({'columns': res.column_names | list, 'rows': out})) -%}\n"
        "{%- endfor -%}\n"
        "{%- endif -%}\n"
        "select 1 as wickd_batch"
    )


def parse_batch_output(text: str) -> dict[int, tuple[list[str], list[list]]]:
    """{index: (columns, rows)} for every well-formed marker line; logs around them are ignored."""
    found: dict[int, tuple[list[str], list[list]]] = {}
    for line in text.splitlines():
        _, sep, rest = line.partition(BATCH_MARKER)
        index, colon, payload = rest.partition(":")
        if not sep or not colon or not index.isdigit():
            continue
        try:
            data = json.loads(payload)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        columns, rows = data.get("columns"), data.get("rows")
        if isinstance(columns, list) and isinstance(rows, list) and all(isinstance(r, list) for r in rows):
            found[int(index)] = ([str(c) for c in columns], rows)
    return found


def query_timeout(env: dict[str, str]) -> float:
    """The project's METRIC_QUERY_TIMEOUT in seconds (default 120, capped at an hour)."""
    raw = (env.get(TIMEOUT_KEY) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_QUERY_TIMEOUT_S
    return min(value, MAX_QUERY_TIMEOUT_S) if value > 0 else DEFAULT_QUERY_TIMEOUT_S


def _with_jinja(sqls: list[str]) -> set[int]:
    return {i for i, s in enumerate(sqls) if any(t in s for t in _JINJA_TOKENS)}


def other_target_path(project_id: int, target: str) -> Path:
    """Where dbt writes its artifacts when run on a target other than the active one (data diff)."""
    return settings.data_dir / "targets" / str(project_id) / target


def startup_message() -> str:
    return (f"dbt didn't finish starting (parsing the project) within {STARTUP_ALLOWANCE_S:.0f}s, "
            f"{STARTUP_ATTEMPTS} times in a row, so these queries weren't run.")


@dataclass
class _Run:
    """One whole run_many() call: its queries, settings and the results so far."""
    project_id: int
    project_path: Path
    sqls: list[str]
    limit: int
    env: dict[str, str]
    target: str | None
    timeout: float
    slots: int
    seed_from: Path
    results: dict[int, BatchResult] = field(default_factory=dict)
    deliveries: asyncio.Queue[tuple[int, BatchResult] | None] = field(default_factory=asyncio.Queue)

    def put(self, index: int, result: BatchResult) -> None:
        if index in self.results:
            return
        self.results[index] = result
        self.deliveries.put_nowait((index, result))

    def put_rows(self, index: int, columns: list[str], rows: list[list]) -> None:
        self.put(index, BatchResult(columns, rows[:self.limit], len(rows) > self.limit))


@dataclass
class _Batch:
    """One dbt show over some of the run's queries: how it ended."""
    started: bool = False  # dbt parsed the project and reached the queries
    found: int = 0
    detail: str = ""
    timed_out: bool = False


async def _run_batch(run: _Run, chunk: list[int], target_path: Path) -> _Batch:
    req = RunRequest(
        project_id=run.project_id,
        project_path=run.project_path,
        command="show",
        extra=("--inline", build_batch_sql([run.sqls[i] for i in chunk], chunk, run.limit), "--limit", "1",
               "--output", "json", "--target-path", str(target_path))
        + (("--target", run.target) if run.target else ()),
        env=run.env,
    )
    batch = _Batch()
    logs: list[str] = []
    loop = asyncio.get_running_loop()
    try:
        async with aclosing(runner.run_lines(req, locked=False)) as lines, \
                asyncio.timeout_at(loop.time() + STARTUP_ALLOWANCE_S) as deadline:
            async for line in lines:
                if START_MARKER in line and BATCH_MARKER not in line:
                    batch.started = True
                    deadline.reschedule(loop.time() + run.timeout)  # the first query's clock starts now
                    continue
                found = parse_batch_output(line)
                if not found:
                    logs.append(line)
                    continue
                batch.started = True
                for i, (columns, rows) in found.items():
                    if i in chunk:
                        run.put_rows(i, columns, rows)
                        batch.found += 1
                deadline.reschedule(loop.time() + run.timeout)  # the next query's clock starts now
    except TimeoutError:
        batch.timed_out = True
    batch.detail = error_detail("\n".join(logs))
    return batch


async def _worker(run: _Run, mine: list[int]) -> None:
    """Run the queries at `mine` in order, a new dbt show after each failure."""
    pos = 0
    slow_starts = 0
    while pos < len(mine):
        chunk = [i for i in mine[pos:] if i not in run.results]
        if not chunk:
            return
        async with show_slots.slot(run.project_id, run.slots) as slot_id:
            target_path = show_slots.slot_target_path(run.project_id, run.target, slot_id)
            await asyncio.to_thread(show_slots.seed_partial_parse, run.seed_from, target_path)
            batch = await _run_batch(run, chunk, target_path)
        failed = next((k for k, i in enumerate(chunk) if i not in run.results), None)
        if failed is None:
            return
        index = chunk[failed]
        if not batch.started:
            if batch.timed_out and (slow_starts := slow_starts + 1) < STARTUP_ATTEMPTS:
                log.warning("metric_batch_slow_start", project_id=run.project_id, queries=len(chunk),
                            startup_s=int(STARTUP_ALLOWANCE_S))
                continue
            message = startup_message() if batch.timed_out else batch.detail
            log.warning("metric_batch_not_started", project_id=run.project_id, queries=len(chunk),
                        timed_out=batch.timed_out, error=message[:2000])
            for i in chunk:
                run.put(i, BatchResult([], [], False, message))
            return
        slow_starts = 0
        if batch.timed_out:
            log.warning("metric_query_timeout", project_id=run.project_id, query=index + 1, of=len(run.sqls),
                        timeout_s=int(run.timeout), sql=run.sqls[index][:2000])
            message = timeout_message(run.timeout, index=index, total=len(run.sqls))
        else:
            log.warning("metric_query_failed", project_id=run.project_id, query=index + 1, of=len(run.sqls),
                        error=batch.detail[:2000], sql=run.sqls[index][:2000])
            message = batch.detail
        run.put(index, BatchResult([], [], False, message))
        pos = mine.index(index) + 1


async def _work(run: _Run, pending: list[int], lock_wait: float) -> None:
    try:
        async with runner.shared_lock(run.project_id, lock_wait):
            workers = min(show_slots.pool_size(run.project_id, run.slots), len(pending))
            async with asyncio.TaskGroup() as group:
                for w in range(workers):
                    group.create_task(_worker(run, pending[w::workers]))
    except TimeoutError:
        busy = f"dbt stayed busy with another command for {lock_wait:.0f}s"
        for i in pending:
            run.put(i, BatchResult([], [], False, busy))


async def _deliver(run: _Run, on_result: OnResult | None, active: query_control.ActiveRun | None) -> None:
    while (item := await run.deliveries.get()) is not None:
        if on_result is not None:
            try:
                await on_result(*item)
            except Exception:  # a failed store mustn't stop the other results
                log.exception("metric_result_callback_failed", project_id=run.project_id, query=item[0])
        if active is not None:
            await query_control.advance(active)


async def _until_cancelled(work: asyncio.Task, active: query_control.ActiveRun | None) -> bool:
    """Wait for `work`; True if the run was cancelled first (then `work` is stopped)."""
    if active is None:
        await work
        return False
    stop = asyncio.create_task(active.cancel_event.wait())
    try:
        await asyncio.wait({work, stop}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop.cancel()
        if not work.done():
            work.cancel()
            with suppress(asyncio.CancelledError):
                await work  # its dbt processes are stopped before this returns
    if work.cancelled():
        return True
    work.result()  # a bug in a worker surfaces here
    return False


async def run_many(
    project_id: int, project_path: Path, sqls: list[str], *, limit: int = MAX_ROW_LIMIT, target: str | None = None,
    lock_wait: float = LOCK_WAIT_S, kind: str | None = None, run_id: str | None = None,
    on_result: OnResult | None = None,
) -> list[BatchResult]:
    """One BatchResult per SQL, in order; a failing or timed-out statement gets `error`, the
    others still run.

    `target` overrides the project's active dbt target (a monitor pinned to one, compare mode's
    base target). `lock_wait`: how long to wait for another dbt command on the project to finish.
    `kind` (query_control.METRIC_KINDS) registers the run for progress and Cancel; `run_id` names
    it. `on_result(index, result)` is awaited for each answered query as it arrives (one at a time),
    never for cancelled ones."""
    limit = max(1, min(limit, MAX_ROW_LIMIT))
    env = await load_project_env(project_id)
    info = await service.manifest_info(project_path)
    run = _Run(
        project_id, project_path, sqls, limit, env, target or env.get("DBT_TARGET") or None, query_timeout(env),
        show_slots.query_concurrency(env, info.adapter_type), service.target_dir(project_path),
    )
    active = await query_control.start(project_id, kind, len(sqls), run_id=run_id) if kind else None
    deliverer = asyncio.create_task(_deliver(run, on_result, active))
    try:
        jinja = _with_jinja(sqls)
        for i in sorted(jinja):
            run.put(i, BatchResult([], [], False, "Jinja isn't allowed in a batched query"))
        pending = [i for i in range(len(sqls)) if i not in jinja]
        cancelled = bool(pending) and await _until_cancelled(asyncio.create_task(_work(run, pending, lock_wait)), active)
        run.deliveries.put_nowait(None)
        await deliverer
    except BaseException:
        deliverer.cancel()
        raise
    finally:
        if active is not None:
            await query_control.finish(active)
    if cancelled:
        log.info("metric_batch_cancelled", project_id=project_id, done=len(run.results), of=len(sqls))
    out = [run.results.get(i) or BatchResult([], [], False, CANCELLED, cancelled=True) for i in range(len(sqls))]
    if len(run.results) < len(sqls) and not cancelled:
        log.warning("metric_batch_incomplete", project_id=project_id, done=len(run.results), of=len(sqls))
    return out
