"""Run many MetricFlow queries with one `dbt show` (dashboards and monitors; plans 10–11).

dbt's startup (~1.4 s) dominates a metric query, so N queries share one invocation:
inline Jinja calls `run_query()` per statement and prints `WICKD_METRIC_BATCH:<i>:<json>`
right after each one, the same trick as dbt/probe.py's column batch. Jinja can't catch a
failing statement, so it ends the compile: statements before it have already printed,
the one that didn't is the failure, and the rest run in a new batch. N queries with F
failures cost F + 1 dbt starts.

Values go through Jinja first: numbers stay numbers (decimals become floats), nulls
and booleans stay, anything else (dates, timestamps) becomes its string form.
"""

import asyncio
import json
from contextlib import aclosing
from dataclasses import dataclass, field
from pathlib import Path

from app.api.init import load_project_env
from app.config import settings
from app.dbt.runner import RunRequest, runner
from app.logging_setup import get_logger
from app.semantic.execute import LOCK_WAIT_S, MAX_ROW_LIMIT, error_detail, wait_for_lock

log = get_logger(__name__)

BATCH_MARKER = "WICKD_METRIC_BATCH:"
# Each query gets METRIC_QUERY_TIMEOUT seconds (a project setting) from the previous one's result;
# the first also gets dbt's startup (parsing the project) on top.
TIMEOUT_KEY = "METRIC_QUERY_TIMEOUT"
DEFAULT_QUERY_TIMEOUT_S = 120
MAX_QUERY_TIMEOUT_S = 3600
STARTUP_ALLOWANCE_S = 120.0
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


def _limited(sql: str, limit: int) -> str:
    return f"select * from (\n{sql.strip().rstrip(';')}\n) as wickd_metric_batch limit {limit + 1}"


def build_batch_sql(sqls: list[str], start: int, limit: int) -> str:
    """Inline Jinja running `sqls` in order, printing each result tagged with start + i."""
    return (
        "{%- if execute -%}\n"
        f"{{%- set wickd_sqls = {json.dumps([_limited(s, limit) for s in sqls])} -%}}\n"
        "{%- for q in wickd_sqls -%}\n"
        "{%- set res = run_query(q) -%}\n"
        f"{_ROW_JINJA}\n"
        f"{{%- do print('{BATCH_MARKER}' ~ (loop.index0 + {start}) ~ ':' ~ "
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


@dataclass
class _BatchRun:
    """One dbt show over sqls[start:end]: the results it printed, and how it ended."""
    found: dict[int, tuple[list[str], list[list]]] = field(default_factory=dict)
    detail: str = ""
    fatal: bool = False  # nothing ran (dbt busy): retrying the rest would only wait again
    timed_out: bool = False


async def _run_batch(
    project_id: int, project_path: Path, sqls: list[str], start: int, limit: int,
    env: dict[str, str], target: str | None, target_path: Path | None, timeout: float, lock_wait: float,
) -> _BatchRun:
    if not await wait_for_lock(project_id, lock_wait):
        return _BatchRun(detail=f"dbt stayed busy with another command for {lock_wait:.0f}s", fatal=True)
    req = RunRequest(
        project_id=project_id,
        project_path=project_path,
        command="show",
        extra=("--inline", build_batch_sql(sqls, start, limit), "--limit", "1", "--output", "json")
        + (("--target", target) if target else ()),
        env=env,
    )
    if target_path:
        req.extra += ("--target-path", str(target_path))
    run = _BatchRun()
    logs: list[str] = []
    loop = asyncio.get_running_loop()
    try:
        async with aclosing(runner.run_lines(req)) as lines, asyncio.timeout(STARTUP_ALLOWANCE_S + timeout) as deadline:
            async for line in lines:
                found = parse_batch_output(line)
                if found:
                    run.found.update(found)
                    deadline.reschedule(loop.time() + timeout)  # the next query's clock starts now
                else:
                    logs.append(line)
    except TimeoutError:
        run.timed_out = True
    run.detail = error_detail("\n".join(logs))
    if len(run.found) < len(sqls):
        log.info("metric_batch_partial", project_id=project_id, start=start, count=len(sqls), done=len(run.found),
                 timed_out=run.timed_out)
    return run


def _timeout_message(index: int, total: int, timeout: float) -> str:
    return (f"Query {index + 1} of {total} took longer than {timeout:.0f}s "
            f"(the project's {TIMEOUT_KEY} setting) and was stopped.")


def other_target_path(project_id: int, target: str) -> Path:
    """Where dbt writes its artifacts when run on a target other than the active one."""
    return settings.data_dir / "targets" / str(project_id) / target


async def run_many(
    project_id: int, project_path: Path, sqls: list[str], *, limit: int = MAX_ROW_LIMIT, target: str | None = None,
    lock_wait: float = LOCK_WAIT_S,
) -> list[BatchResult]:
    """One BatchResult per SQL, in order; a failing or timed-out statement gets `error`, the
    others still run.

    `target` overrides the project's active dbt target (a monitor pinned to one, compare mode's
    base target). `dbt show` re-parses and writes target/manifest.json + semantic_manifest.json
    for the target it runs on, so another target writes them under the data dir instead — the
    project's artifacts (which explains read) keep pointing at the active target's relations.
    `lock_wait`: how long to wait for another dbt command on the project to finish."""
    limit = max(1, min(limit, MAX_ROW_LIMIT))
    results: dict[int, BatchResult] = {
        i: BatchResult([], [], False, "Jinja isn't allowed in a batched query") for i in _with_jinja(sqls)
    }
    env = await load_project_env(project_id)
    timeout = query_timeout(env)
    active = env.get("DBT_TARGET")
    target_path = other_target_path(project_id, target) if target and target != active else None
    target = target or active
    start = 0
    stalled = 0  # batches in a row that timed out before printing anything
    while start < len(sqls):
        if start in results:
            start += 1
            continue
        end = next((i for i in range(start, len(sqls)) if i in results), len(sqls))
        run = await _run_batch(project_id, project_path, sqls[start:end], start, limit, env, target, target_path,
                               timeout, lock_wait)
        if run.fatal:
            results.update({i: BatchResult([], [], False, run.detail) for i in range(start, end)})
            start = end
            continue
        for i, (columns, rows) in run.found.items():
            if start <= i < end:
                results[i] = BatchResult(columns, rows[:limit], len(rows) > limit)
        failed = next((i for i in range(start, end) if i not in results), None)
        if failed is None:
            start = end
            continue
        if run.timed_out:
            stalled = 0 if run.found else stalled + 1
            log.warning("metric_query_timeout", project_id=project_id, query=failed + 1, of=len(sqls),
                        timeout_s=int(timeout), sql=sqls[failed][:2000])
            results[failed] = BatchResult([], [], False, _timeout_message(failed, len(sqls), timeout))
            if stalled >= 2:  # dbt itself seems stuck (startup or connection): don't retry the rest
                stuck = f"Not run: dbt timed out twice in a row without returning any result ({timeout:.0f}s per query)."
                results.update({i: BatchResult([], [], False, stuck) for i in range(failed + 1, end)})
                start = end
                continue
        else:
            stalled = 0
            log.warning("metric_query_failed", project_id=project_id, query=failed + 1, of=len(sqls),
                        error=run.detail[:2000], sql=sqls[failed][:2000])
            results[failed] = BatchResult([], [], False, run.detail)
        start = failed + 1
    return [results[i] for i in range(len(sqls))]
