import pytest

from app.semantic.query_spec import QueryInvalid, check_query, check_where, checked_sql

CATALOG = {
    "metrics": [{"name": "revenue"}, {"name": "orders"}],
    "saved_queries": [{"name": "weekly_revenue"}],
}


@pytest.mark.parametrize("where", [
    "{{ Dimension('customer__country') }} = 'US'",
    "{{ Dimension('customer__country') }} in ('US', 'CA') and {{ Entity('customer') }} is not null",
    "{{ TimeDimension('metric_time', 'week') }} >= '2026-01-01'",
    "{{ Dimension('order__order_date').grain('month') }} > date '2026-01-01'",
    "{{ Metric('revenue', group_by=['customer']) }} > 100",
    "lower({{ Dimension(\"order__channel\") }}) like '%web%'",
])
def test_allowed_filters(where):
    check_where(where, "duckdb")


@pytest.mark.parametrize("where, message", [
    ("country = 'US'", "must reference a dimension"),
    ("{{ run_query('drop table x') }} = 1", "only"),
    ("{{ Dimension(x) }} = 1", "only"),
    ("{% if true %}1{% endif %} = {{ Dimension('a') }}", "{%"),
    ("{{ Dimension('a') }} = 1; drop table x", "';'"),
    ("{{ Dimension('a') }} = 1 -- trailing", "'--'"),
    ("{{ Dimension('a') }} in (select id from secrets)", "subqueries"),
    ("{{ Dimension('a') }} = 1 group by 1", "single SQL condition"),
    ("{{ Dimension('a') }} = = 1", "couldn't read"),
    ("{{ Dimension('a') }} = 1 # mysql comment", "'#'"),
    ("{{ Dimension('a') }} = 1 // snowflake comment", "'//'"),
    ("{{ Dimension('a') }} = '\\' or 1 = 1 or 'x' = '", "can't contain"),
])
def test_rejected_filters(where, message):
    with pytest.raises(QueryInvalid, match=message):
        check_where(where, "duckdb")


def test_filter_length_cap():
    with pytest.raises(QueryInvalid, match="too long"):
        check_where("{{ Dimension('a') }} = '" + "x" * 5000 + "'", "duckdb")


def test_check_query_accepts_known_names():
    check_query({"metrics": ["revenue", "orders"], "group_by": ["metric_time__week", "customer__country"],
                 "order_by": ["-metric_time__week"]}, CATALOG, "duckdb")
    check_query({"saved_query": "weekly_revenue"}, CATALOG, "duckdb")


@pytest.mark.parametrize("query, message", [
    ({}, "at least one metric"),
    ({"metrics": ["revenue", "nope"]}, "unknown metric: nope"),
    ({"saved_query": "missing"}, "no saved query"),
    ({"metrics": ["revenue"], "group_by": ["customer__country) --"]}, "group-by"),
    ({"metrics": ["revenue"], "order_by": ["revenue desc"]}, "order-by"),
    ({"metrics": ["revenue"], "where": ["1 = 1"]}, "must reference"),
])
def test_check_query_rejects(query, message):
    with pytest.raises(QueryInvalid, match=message):
        check_query(query, CATALOG, "duckdb")


def test_checked_sql_allows_one_select_and_rejects_writes():
    assert checked_sql("-- comment\nSELECT 1 AS a;", "duckdb") == "-- comment\nSELECT 1 AS a"
    with pytest.raises(QueryInvalid, match="read-only"):
        checked_sql("select 1; delete from t", "duckdb")


def test_checked_sql_allows_long_metricflow_sql():
    long_sql = "SELECT " + ", ".join(f"col_{i}" for i in range(5000)) + " FROM t"
    assert len(long_sql) > 20_000
    assert checked_sql(long_sql, "duckdb").startswith("SELECT col_0")
