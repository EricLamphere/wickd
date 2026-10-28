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
from dataclasses import dataclass
from pathlib import Path

from app.api.init import load_project_env
from app.dbt.runner import RunRequest, runner
from app.logging_setup import get_logger
from app.semantic.execute import LOCK_WAIT_S, MAX_ROW_LIMIT, wait_for_lock

log = get_logger(__name__)

BATCH_MARKER = "WICKD_METRIC_BATCH:"
BASE_TIMEOUT_S = 120
SECONDS_PER_QUERY = 30
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


def error_detail(text: str) -> str:
    """dbt's error message (after "Encountered an error:"), else the output's tail."""
    _, sep, after = text.rpartition("Encountered an error:")
    detail = (after if sep else text).strip()
    return detail[-1500:] or "dbt show failed"


def _with_jinja(sqls: list[str]) -> set[int]:
    return {i for i, s in enumerate(sqls) if any(t in s for t in _JINJA_TOKENS)}


async def run_many(
    project_id: int, project_path: Path, sqls: list[str], *, limit: int = MAX_ROW_LIMIT, target: str | None = None
) -> list[BatchResult]:
    """One BatchResult per SQL, in order; a failing statement gets `error`, the others still run.

    `target` overrides the project's active dbt target (a monitor pinned to one)."""
    limit = max(1, min(limit, MAX_ROW_LIMIT))
    results: dict[int, BatchResult] = {
        i: BatchResult([], [], False, "Jinja isn't allowed in a batched query") for i in _with_jinja(sqls)
    }
    env = await load_project_env(project_id)
    target = target or env.get("DBT_TARGET")
    start = 0
    while start < len(sqls):
        if start in results:
            start += 1
            continue
        end = next((i for i in range(start, len(sqls)) if i in results), len(sqls))
        found, detail, fatal = await _run_batch(project_id, project_path, sqls[start:end], start, limit, env, target)
        if fatal:  # busy or timed out: retrying the rest would only wait again
            results.update({i: BatchResult([], [], False, detail) for i in range(start, end)})
            start = end
            continue
        for i, (columns, rows) in found.items():
            if start <= i < end:
                results[i] = BatchResult(columns, rows[:limit], len(rows) > limit)
        failed = next((i for i in range(start, end) if i not in results), None)
        if failed is None:
            start = end
            continue
        results[failed] = BatchResult([], [], False, detail)
        start = failed + 1
    return [results[i] for i in range(len(sqls))]


async def _run_batch(
    project_id: int, project_path: Path, sqls: list[str], start: int, limit: int,
    env: dict[str, str], target: str | None,
) -> tuple[dict[int, tuple[list[str], list[list]]], str, bool]:
    """(results by index, dbt's error message, whether the whole batch failed before running)."""
    if not await wait_for_lock(project_id):
        return {}, f"dbt stayed busy with another command for {LOCK_WAIT_S:.0f}s", True
    req = RunRequest(
        project_id=project_id,
        project_path=project_path,
        command="show",
        extra=("--inline", build_batch_sql(sqls, start, limit), "--limit", "1", "--output", "json")
        + (("--target", target) if target else ()),
        env=env,
    )
    try:
        async with asyncio.timeout(BASE_TIMEOUT_S + SECONDS_PER_QUERY * len(sqls)):
            _code, stdout, stderr = await runner.run(req)
    except TimeoutError:
        return {}, "the batch timed out", True
    out, err = stdout.decode(errors="replace"), stderr.decode(errors="replace")
    found = {**parse_batch_output(err), **parse_batch_output(out)}
    if len(found) < len(sqls):
        log.info("metric_batch_partial", project=project_id, start=start, count=len(sqls), done=len(found))
    return found, error_detail(out + "\n" + err), False
