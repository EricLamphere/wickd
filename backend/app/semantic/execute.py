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
QUERY_TIMEOUT_S = 120
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


async def wait_for_lock(project_id: int) -> bool:
    waited = 0.0
    while runner.is_project_busy(project_id):
        if waited >= LOCK_WAIT_S:
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
    env = await load_project_env(project_id)
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
        async with asyncio.timeout(QUERY_TIMEOUT_S):
            code, stdout, stderr = await runner.run(req)
    except TimeoutError:
        raise ExecutionError("timeout", f"The query took longer than {QUERY_TIMEOUT_S}s.") from None
    out = stdout.decode(errors="replace")
    columns, rows = parse_show_json(out)
    if code != 0 or not columns:
        raise ExecutionError("dbt_show_failed", error_detail(out + "\n" + stderr.decode(errors="replace")))
    return QueryResult(columns=columns, rows=rows[:limit], truncated=len(rows) > limit)
