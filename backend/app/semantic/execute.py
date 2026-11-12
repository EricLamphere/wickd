"""Run MetricFlow's SQL on the user's warehouse via their own dbt (`dbt show --inline`).

Same approach as Query data (api/ai_query.py): bounded wait for the project's runner
lock, a timeout, parse_show_json(). Batches of queries: batch.py.
"""

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path

import sqlglot
from sqlglot.errors import ParseError

from app.ai.sql_guard import dialect_for
from app.api.init import load_project_env
from app.dbt.runner import RunRequest, runner
from app.dbt.show_parser import parse_show_json
from app.logging_setup import get_logger

log = get_logger(__name__)

DEFAULT_ROW_LIMIT = 500
MAX_ROW_LIMIT = 5000
LOCK_WAIT_S = 60.0
LOCK_POLL_S = 0.25
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_TIMESTAMP = re.compile(r"^\s*\d{2}:\d{2}:\d{2}(\.\d+)?\s*")


def error_detail(text: str) -> str:
    """dbt's error message (after "Encountered an error:"), else the output's tail; colours removed."""
    plain = _ANSI.sub("", text)
    before, sep, after = plain.rpartition("Encountered an error:")
    if not sep:
        return plain.strip()[-1500:] or "dbt show failed"
    # dbt logs the specifics (which ref/source is missing, the database error) a line or two earlier
    lines = [_TIMESTAMP.sub("", line).strip() for line in before.splitlines()]
    first = next((i for i, line in enumerate(lines) if "rror" in line), len(lines))
    detail = "\n".join([*(line for line in lines[first:] if line), after.strip()]).strip()
    return detail[-1500:] or "dbt show failed"


class ExecutionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class QueryResult:
    columns: list[str]
    rows: list[list]
    truncated: bool


def for_dbt_show(sql: str, adapter_type: str | None) -> str:
    """dbt appends its own `limit N`, a syntax error after a query's own LIMIT: wrap those."""
    cleaned = sql.strip().rstrip(";").strip()
    try:
        statement = sqlglot.parse_one(cleaned, read=dialect_for(adapter_type))
    except ParseError:
        statement = None
    if statement is None or statement.args.get("limit") or statement.args.get("fetch"):
        return f"select * from (\n{cleaned}\n) as wickd_metric_query"
    return cleaned


def timeout_message(
    timeout: float, *, startup: float = 0.0, index: int | None = None, total: int | None = None
) -> str:
    """Why a query was stopped. `startup`: the extra allowance it had for dbt to start (parse,
    connect), so the total it was given is stated, not just METRIC_QUERY_TIMEOUT."""
    which = f"Query {index + 1} of {total}" if index is not None and total is not None else "The query"
    budget = (f"{timeout + startup:.0f}s ({startup:.0f}s for dbt to start plus the project's "
              f"METRIC_QUERY_TIMEOUT of {timeout:.0f}s)") if startup else \
        f"{timeout:.0f}s (the project's METRIC_QUERY_TIMEOUT setting)"
    return f"{which} didn't finish within {budget} and was stopped."


async def wait_for_lock(project_id: int, seconds: float = LOCK_WAIT_S) -> bool:
    """Wait up to `seconds` for the project's other dbt command to finish; False if it didn't."""
    waited = 0.0
    while runner.is_project_busy(project_id):
        if waited >= seconds:
            return False
        await asyncio.sleep(LOCK_POLL_S)
        waited += LOCK_POLL_S
    return True


async def run_sql(
    project_id: int, project_path: Path, sql: str, adapter_type: str | None, *, limit: int = DEFAULT_ROW_LIMIT
) -> QueryResult:
    limit = max(1, min(limit, MAX_ROW_LIMIT))
    if not await wait_for_lock(project_id):
        raise ExecutionError("busy", "dbt stayed busy with another command — try again in a moment.")
    from app.semantic.batch import (  # batch imports this module
        STARTUP_ALLOWANCE_S,
        query_timeout,
    )

    env = await load_project_env(project_id)
    timeout = query_timeout(env)
    target = env.get("DBT_TARGET")
    req = RunRequest(
        project_id=project_id,
        project_path=project_path,
        command="show",
        extra=("--inline", for_dbt_show(sql, adapter_type), "--limit", str(limit + 1), "--output", "json")
        + (("--target", target) if target else ()),
        env=env,
    )
    try:
        # the clock starts once dbt starts: waiting behind another dbt command doesn't count
        code, stdout, stderr = await runner.run(req, timeout=STARTUP_ALLOWANCE_S + timeout)
    except TimeoutError:
        log.warning("metric_query_timeout", project_id=project_id, timeout_s=int(STARTUP_ALLOWANCE_S + timeout),
                    sql=sql[:2000])
        raise ExecutionError("timeout", timeout_message(timeout, startup=STARTUP_ALLOWANCE_S)) from None
    out = stdout.decode(errors="replace")
    columns, rows = parse_show_json(out)
    if code != 0 or not columns:
        detail = error_detail(out + "\n" + stderr.decode(errors="replace"))
        log.warning("metric_query_failed", project_id=project_id, error=detail[:2000], sql=sql[:2000])
        raise ExecutionError("dbt_show_failed", detail)
    return QueryResult(columns=columns, rows=rows[:limit], truncated=len(rows) > limit)
