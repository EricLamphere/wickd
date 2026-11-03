"""sql_hash(): stable across MetricFlow's per-process subquery alias numbering."""

from app.semantic.query_cache import sql_hash

COLD = """SELECT MAX(subq_10.a) AS a, MAX(subq_17.b) AS b
FROM (SELECT SUM(x) AS a FROM t) subq_10
CROSS JOIN (SELECT SUM(y) AS b FROM u) subq_17"""

WARM = """SELECT MAX(subq_6.a) AS a, MAX(subq_13.b) AS b
FROM (SELECT SUM(x) AS a FROM t) subq_6
CROSS JOIN (SELECT SUM(y) AS b FROM u) subq_13"""


def test_alias_numbering_does_not_change_the_hash() -> None:
    assert sql_hash(COLD) == sql_hash(WARM)


def test_different_queries_still_differ() -> None:
    assert sql_hash(COLD) != sql_hash(WARM.replace("SUM(y)", "SUM(z)"))


def test_alias_order_matters() -> None:
    swapped = COLD.replace("subq_10", "subq_X").replace("subq_17", "subq_10").replace("subq_X", "subq_17")
    # same aliases, used the other way round → the same structure after renumbering
    assert sql_hash(COLD) == sql_hash(swapped)
    # but a query that references one alias where it used another is different
    crossed = COLD.replace("MAX(subq_17.b)", "MAX(subq_10.b)")
    assert sql_hash(COLD) != sql_hash(crossed)


def test_surrounding_whitespace_ignored() -> None:
    assert sql_hash(f"  {COLD}\n") == sql_hash(COLD)
