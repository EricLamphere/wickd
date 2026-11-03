"""Data types a compiled SELECT would produce, for contract checks' "Check types".

One `dbt show --inline` runs dbt's own `get_column_schema_from_query()` (what enforced contracts
use: the query wrapped in an empty `where false limit 0` subquery, so no rows are scanned) for
every SQL and prints `[name, data_type]` pairs as one JSON line after TYPES_MARKER. The SQLs are
embedded as Jinja string literals with braces escaped, so compiled SQL containing `{{` can't be
rendered as Jinja. One failing query fails the whole invocation; each SQL is then probed alone.
"""

import asyncio
import json
from pathlib import Path

from app.dbt.runner import RunRequest, runner
from app.logging_setup import get_logger

log = get_logger(__name__)

TYPES_MARKER = "WICKD_CONTRACT_TYPES:"
TIMEOUT_SECONDS = 60
SECONDS_PER_QUERY = 5


def _literal(value: str) -> str:
    """A Jinja string literal for `value` with no `{` / `}` in its source text."""
    return json.dumps(value).replace("{", "\\u007b").replace("}", "\\u007d")


def build_types_sql(queries: dict[str, str]) -> str:
    items = ", ".join(f"[{_literal(key)}, {_literal(sql)}]" for key, sql in queries.items())
    return (
        f"{{%- set wickd_queries = [{items}] -%}}\n"
        "{% if execute %}\n"
        "{%- set wickd_types = {} -%}\n"
        "{%- for pair in wickd_queries -%}\n"
        "{%- set cols = [] -%}\n"
        "{%- for c in get_column_schema_from_query(pair[1]) -%}"
        "{%- do cols.append([c.name, c.data_type]) -%}"
        "{%- endfor -%}\n"
        "{%- do wickd_types.update({pair[0]: cols}) -%}\n"
        "{%- endfor -%}\n"
        f"{{%- do print('{TYPES_MARKER}' ~ tojson(wickd_types)) -%}}\n"
        "{% endif %}\n"
        "select 1 as wickd_probe"
    )


def parse_types_output(text: str) -> dict[str, dict[str, str]] | None:
    for line in text.splitlines():
        _, sep, payload = line.partition(TYPES_MARKER)
        if not sep:
            continue
        try:
            data = json.loads(payload)
        except ValueError:
            return None
        if not isinstance(data, dict):
            return None
        return {
            str(key): {str(p[0]): str(p[1] or "") for p in pairs if isinstance(p, list) and len(p) == 2}
            for key, pairs in data.items() if isinstance(pairs, list)
        }
    return None


async def _run(project_id: int, project_path: Path, queries: dict[str, str], env: dict[str, str],
               target: str | None) -> tuple[dict[str, dict[str, str]] | None, str]:
    req = RunRequest(
        project_id=project_id, project_path=project_path, command="show",
        extra=("--inline", build_types_sql(queries), "--limit", "1", "--output", "json",
               *(("--target", target) if target else ())),
        env=env,
    )
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS + SECONDS_PER_QUERY * len(queries)):
            rc, out, err = await runner.run(req)
    except TimeoutError:
        return None, "timed out reading column types"
    text = (out + err).decode(errors="replace")
    parsed = parse_types_output(text) if rc == 0 else None
    if parsed is None:
        _, sep, after = text.rpartition("Encountered an error:")
        return None, ((after if sep else text).strip() or "dbt show failed")[-600:]
    return parsed, ""


async def probe_query_types(
    project_id: int, project_path: Path, queries: dict[str, str], env: dict[str, str], target: str | None,
) -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    """({key: {column: type}}, {key: error}) for each SELECT in `queries`."""
    if not queries:
        return {}, {}
    types, error = await _run(project_id, project_path, queries, env, target)
    if types is not None:
        return types, {}
    log.info("contract_types_batch_failed", project_id=project_id, count=len(queries), error=error[-200:])
    if len(queries) == 1:
        return {}, {next(iter(queries)): error}
    found: dict[str, dict[str, str]] = {}
    errors: dict[str, str] = {}
    for key, sql in queries.items():
        one, one_error = await _run(project_id, project_path, {key: sql}, env, target)
        if one is not None:
            found.update(one)
        else:
            errors[key] = one_error
    return found, errors
