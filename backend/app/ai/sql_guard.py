"""Only let AI-written (or AI-edited) SQL reach the warehouse if it is one read-only query.

The model writes dbt-flavoured SQL (`{{ ref('x') }}`), which `dbt show --inline`
compiles and runs. Two things are checked before that:

1. Jinja: only `{{ ref(...) }}` / `{{ source(...) }}` expressions with literal
   arguments. Anything else — `{% %}` blocks, other macros, `run_query` — could
   execute arbitrary SQL at compile time, so it is rejected outright.
2. SQL: with those replaced by placeholder table names, sqlglot must parse it as
   exactly one statement that is a query (SELECT / WITH / UNION …) containing no
   write, DDL, session or transaction statements anywhere in it.

The user still sees and approves the SQL before it runs; this is the backstop.
"""

import re

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

# dbt adapter_type → sqlglot dialect (None = sqlglot's default dialect)
DIALECTS: dict[str, str] = {
    "snowflake": "snowflake",
    "bigquery": "bigquery",
    "postgres": "postgres",
    "redshift": "redshift",
    "duckdb": "duckdb",
    "databricks": "databricks",
    "spark": "spark",
    "trino": "trino",
    "athena": "athena",
    "sqlserver": "tsql",
    "fabric": "tsql",
    "synapse": "tsql",
    "mysql": "mysql",
    "clickhouse": "clickhouse",
    "oracle": "oracle",
    "teradata": "teradata",
}

FORBIDDEN = tuple(
    getattr(exp, name)
    for name in (
        "Insert", "Update", "Delete", "Merge", "Create", "Drop", "Alter", "TruncateTable",
        "Command", "Into", "Copy", "Grant", "Use", "Set", "Transaction", "Commit", "Rollback",
        "Pragma", "LoadData", "Cache", "Uncache", "Refresh", "Analyze",
    )
    if hasattr(exp, name)
)

MAX_SQL_CHARS = 20_000
_JINJA_EXPR = re.compile(r"\{\{(.*?)\}\}", re.DOTALL)
_RELATION = re.compile(
    r"\s*(ref|source)\(\s*('[^'{}]+'|\"[^\"{}]+\")(\s*,\s*('[^'{}]+'|\"[^\"{}]+\"))?\s*\)\s*"
)


class QueryRejected(ValueError):
    """The SQL isn't a single read-only query wickd will run."""


def dialect_for(adapter_type: str | None) -> str | None:
    return DIALECTS.get((adapter_type or "").lower())


def _replace_jinja(sql: str) -> str:
    if "{%" in sql or "{#" in sql:
        raise QueryRejected("Jinja blocks ({% … %}) aren't allowed — use plain SQL with {{ ref() }}")

    def placeholder(match: re.Match) -> str:
        if not _RELATION.fullmatch(match.group(1)):
            raise QueryRejected(
                f"only {{{{ ref('…') }}}} and {{{{ source('…', '…') }}}} are allowed, not {match.group(0)!r}"
            )
        return f"wickd_relation_{match.start()}"

    return _JINJA_EXPR.sub(placeholder, sql)


def validate_select(sql: str, dialect: str | None, *, max_chars: int = MAX_SQL_CHARS) -> str:
    """The SQL, trimmed and without a trailing semicolon, if it's one read-only query."""
    cleaned, _ = _check(sql, dialect, max_chars)
    return cleaned


def for_dbt_show(sql: str, dialect: str | None) -> str:
    """Validated SQL ready for `dbt show --inline --limit N`.

    dbt appends its own `limit N`, which is a syntax error after a query's own
    LIMIT/FETCH, so such queries are wrapped in a subquery first.
    """
    cleaned, statement = _check(sql, dialect)
    if statement.args.get("limit") or statement.args.get("fetch"):
        return f"select * from (\n{cleaned}\n) as wickd_query"
    return cleaned


def _check(sql: str, dialect: str | None, max_chars: int = MAX_SQL_CHARS) -> tuple[str, exp.Expression]:
    cleaned = sql.strip().rstrip(";").strip()
    if not cleaned:
        raise QueryRejected("the query is empty")
    if len(cleaned) > max_chars:
        raise QueryRejected("the query is too long")
    plain = _replace_jinja(cleaned)
    try:
        statements = [s for s in sqlglot.parse(plain, read=dialect) if s is not None]
    except ParseError as exc:
        raise QueryRejected(f"couldn't verify this is a read-only query: {exc}") from exc
    if len(statements) != 1:
        raise QueryRejected("only a single statement can run")
    statement = statements[0]
    if not isinstance(statement, exp.Query):
        raise QueryRejected("only SELECT queries can run")
    if FORBIDDEN and any(isinstance(node, FORBIDDEN) for node in statement.walk()):
        raise QueryRejected("the query contains a statement that changes data or settings")
    return cleaned, statement
