import pytest

from app.ai.sql_guard import QueryRejected, dialect_for, validate_select


@pytest.mark.parametrize("sql", [
    "select * from {{ ref('orders') }}",
    "select count(*) from {{ source('raw', 'orders') }};",
    "with x as (select 1 as a) select a from x",
    "select a from {{ ref(\"t1\") }} union all select a from {{ ref('t2') }}",
    "  SELECT status, count(*) FROM {{ ref('orders') }} GROUP BY 1 ORDER BY 2 DESC  ;  ",
])
def test_accepts_read_only_queries(sql):
    out = validate_select(sql, "duckdb")
    assert not out.endswith(";") and out == out.strip()
    assert "{{" in out or "with" in out.lower()


@pytest.mark.parametrize("sql, message", [
    ("", "empty"),
    ("delete from {{ ref('orders') }}", "SELECT"),
    ("drop table orders", "SELECT"),
    ("select 1; drop table orders", "single statement"),
    ("create table x as select 1", "SELECT"),
    ("{% do run_query('drop table x') %} select 1", "Jinja blocks"),
    ("select * from {{ run_query('drop table x') }}", "only"),
    ("select * from {{ ref(var('x')) }}", "only"),
    ("select * into new_table from {{ ref('orders') }}", "changes data"),
    ("select from where", "couldn't verify"),
])
def test_rejects(sql, message):
    with pytest.raises(QueryRejected, match=message):
        validate_select(sql, "postgres")


def test_dialects():
    assert dialect_for("sqlserver") == "tsql"
    assert dialect_for("Snowflake") == "snowflake"
    assert dialect_for("weird") is None
    assert dialect_for(None) is None


def test_for_dbt_show_wraps_only_queries_with_their_own_limit():
    from app.ai.sql_guard import for_dbt_show

    assert for_dbt_show("select a from t;", "duckdb") == "select a from t"
    wrapped = for_dbt_show("select a from {{ ref('t') }} order by a limit 5;", "duckdb")
    assert wrapped == "select * from (\nselect a from {{ ref('t') }} order by a limit 5\n) as wickd_query"
    assert for_dbt_show("with x as (select 1 as a) select a from x", "duckdb").startswith("with")
