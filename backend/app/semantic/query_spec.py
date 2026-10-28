"""Validate a metric query before it reaches MetricFlow (pure; unit-tested).

Metric, group-by and order-by names are structured (MetricFlow resolves them and
rejects unknown ones), so they only need to look like names. `where` is different:
MetricFlow renders its `{{ Dimension(...) }}` templates and pastes the rest into the
SQL as-is. So a filter may only contain MetricFlow's object templates with literal
arguments plus a plain SQL condition (literals, operators, functions): no Jinja
blocks, comments, statement separators or subqueries. The final SQL is checked again
(one read-only SELECT) by `checked_sql()`.
"""

import re
from collections.abc import Iterable, Mapping
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

from app.ai.sql_guard import FORBIDDEN, QueryRejected, dialect_for, validate_select

MAX_WHERE_CHARS = 4000

_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ORDER_NAME = re.compile(r"^-?[A-Za-z_][A-Za-z0-9_]*$")
_TEMPLATE = re.compile(r"\{\{(.*?)\}\}", re.DOTALL)
_STR = r"""(?:'[A-Za-z0-9_]+'|"[A-Za-z0-9_]+")"""
_STR_LIST = rf"\[\s*(?:{_STR}\s*(?:,\s*{_STR}\s*)*)?\]"
_ARG = rf"(?:(?:[a-z_]+\s*=\s*)?(?:{_STR}|{_STR_LIST}|True|False))"
_CALL = rf"(?:Dimension|TimeDimension|Entity|Metric)\(\s*{_ARG}(?:\s*,\s*{_ARG})*\s*\)"
_METHOD = rf"\.(?:grain|date_part|descending)\(\s*(?:{_STR}|True|False)\s*\)"
_ALLOWED_TEMPLATE = re.compile(rf"\s*{_CALL}(?:{_METHOD})*\s*")
# Statement/comment syntax of any warehouse (`#` MySQL/BigQuery, `//` Snowflake), Jinja, and
# backslashes: some warehouses treat `\'` as an escaped quote where sqlglot sees a string end
_FORBIDDEN_TEXT = ("{%", "{#", "%}", "#}", "{{", "}}", ";", "--", "/*", "*/", "#", "//", "\\")
# MetricFlow's SQL for many metrics × group-bys runs long; this only bounds parsing
MAX_METRICFLOW_SQL_CHARS = 500_000


class QueryInvalid(ValueError):
    """The query (or its final SQL) isn't one wickd will run."""


def _check_names(names: Iterable[str], pattern: re.Pattern, what: str) -> None:
    for name in names:
        if not pattern.fullmatch(name):
            raise QueryInvalid(f"`{name}` isn't a valid {what} name")


def check_where(where: str, adapter_type: str | None) -> None:
    """Raise QueryInvalid unless `where` is MetricFlow templates + a plain SQL condition."""
    if len(where) > MAX_WHERE_CHARS:
        raise QueryInvalid("the filter is too long")
    count = 0

    def placeholder(match: re.Match) -> str:
        nonlocal count
        if not _ALLOWED_TEMPLATE.fullmatch(match.group(1)):
            raise QueryInvalid(
                f"only {{{{ Dimension('…') }}}}, {{{{ TimeDimension('…', '…') }}}}, {{{{ Entity('…') }}}} "
                f"and {{{{ Metric('…', group_by=[…]) }}}} are allowed in filters, not {match.group(0)!r}"
            )
        count += 1
        return f"wickd_filter_{count}"

    plain = _TEMPLATE.sub(placeholder, where)
    for token in _FORBIDDEN_TEXT:
        if token in plain:
            raise QueryInvalid(f"filters can't contain {token!r}")
    if count == 0:
        raise QueryInvalid("a filter must reference a dimension, e.g. {{ Dimension('customer__country') }} = 'US'")
    try:
        statement = sqlglot.parse_one(f"select 1 where {plain}", read=dialect_for(adapter_type))
    except ParseError as exc:
        raise QueryInvalid(f"couldn't read the filter as a SQL condition: {exc}") from exc
    condition = statement.args.get("where") if isinstance(statement, exp.Select) else None
    if condition is None or statement.args.get("from") or statement.args.get("group"):
        raise QueryInvalid("a filter must be a single SQL condition")
    for node in condition.walk():
        if isinstance(node, (exp.Query, exp.Subquery)) or (FORBIDDEN and isinstance(node, FORBIDDEN)):
            raise QueryInvalid("filters can't contain subqueries or statements")


def check_query(query: Mapping[str, Any], catalog: Mapping[str, Any], adapter_type: str | None) -> None:
    """Raise QueryInvalid for unknown metrics / saved queries, malformed names or filters."""
    saved_query = query.get("saved_query")
    metrics = list(query.get("metrics") or [])
    if saved_query:
        known = {q["name"] for q in catalog.get("saved_queries", [])}
        if saved_query not in known:
            raise QueryInvalid(f"there's no saved query named `{saved_query}`")
    elif not metrics:
        raise QueryInvalid("pick at least one metric")
    known_metrics = {m["name"] for m in catalog.get("metrics", [])}
    unknown = [m for m in metrics if m not in known_metrics]
    if unknown:
        raise QueryInvalid(f"unknown metric{'s' if len(unknown) > 1 else ''}: {', '.join(unknown)}")
    _check_names(query.get("group_by") or [], _NAME, "group-by")
    _check_names(query.get("order_by") or [], _ORDER_NAME, "order-by")
    for where in query.get("where") or []:
        check_where(where, adapter_type)


def checked_sql(sql: str, adapter_type: str | None) -> str:
    """MetricFlow's SQL, if it's one read-only SELECT (the backstop after check_query)."""
    try:
        return validate_select(sql, dialect_for(adapter_type), max_chars=MAX_METRICFLOW_SQL_CHARS)
    except QueryRejected as exc:
        raise QueryInvalid(f"MetricFlow's SQL didn't pass wickd's read-only check: {exc}") from exc
