"""Unit test diff parser — fixtures captured from dbt 1.10.13 (dbt-duckdb) run_results.json."""

from app.dbt.unit_test_diff import coerce, parse_unit_test_diff

COLORED = (
    "\n\n\x1b[32mactual\x1b[0m differs from \x1b[31mexpected\x1b[0m:\n\n"
    "\x1b[0;1m@@\x1b[0m\x1b[33m,\x1b[0m\x1b[0;1mid\x1b[0m\x1b[33m,\x1b[0m\x1b[0;1mcustomer_name\x1b[0m"
    "\x1b[33m,\x1b[0m\x1b[0;1mstate\x1b[0m\x1b[33m,\x1b[0m\x1b[0;1mamount\x1b[0m\r\n"
    "  \x1b[33m,\x1b[0m1 \x1b[33m,\x1b[0mAnn          \x1b[33m,\x1b[0mdone \x1b[33m,\x1b[0m3.0\r\n"
    "\x1b[31;1m\x1b[34;1m→\x1b[32;1m\x1b[0m \x1b[33m,\x1b[0m2 \x1b[33m,\x1b[0m\x1b[31;1mBob\x1b[34;1m→"
    "\x1b[32;1mNULL\x1b[0m     \x1b[33m,\x1b[0mback \x1b[33m,\x1b[0m\x1b[31;1m5.0\x1b[34;1m→\x1b[32;1m4.0\x1b[0m\r\n\n"
)

PLAIN_MIXED = (
    "\n\nactual differs from expected:\n\n"
    "@@ ,id ,customer_name,state,amount\r\n"
    "   ,1  ,Ann          ,done ,3.0\r\n"
    "---,1  ,\"a, b\"       ,done ,Decimal('3.0')\r\n"
    "→  ,7→2,Zed→NULL     ,back ,5.0→4.0\r\n\n"
)

ADDED = (
    "\n\nactual differs from expected:\n\n@@ ,id,customer_name,state,amount\r\n"
    "   ,1 ,Ann          ,done ,3.0\r\n+++,2 ,null         ,back ,Decimal('4.0')\r\n\n"
)

EMPTY_EXPECT = (
    "\n\nactual differs from expected:\n\n@@ ,id,customer_name,state,amount,ordered_at\r\n"
    "+++,1 ,Ann          ,done ,Decimal('3.0')   ,null\r\n"
    "+++,2 ,null         ,back ,Decimal('4.0')   ,null\r\n\n"
)


def test_colored_changed_row():
    diff = parse_unit_test_diff(COLORED)
    assert diff is not None
    assert diff.columns == ("id", "customer_name", "state", "amount")
    same, changed = diff.rows
    assert same.status == "same" and same.actual == ("1", "Ann", "done", "3.0")
    assert changed.status == "changed"
    assert changed.expected == ("2", "Bob", "back", "5.0")
    assert changed.actual == ("2", None, "back", "4.0")


def test_quoted_cells_removed_rows_and_changed_keys():
    diff = parse_unit_test_diff(PLAIN_MIXED)
    assert diff is not None
    statuses = [r.status for r in diff.rows]
    assert statuses == ["same", "removed", "changed"]
    removed = diff.rows[1]
    assert removed.expected == ("1", "a, b", "done", "3.0") and removed.actual is None
    assert diff.rows[2].expected[0] == "7" and diff.rows[2].actual[0] == "2"


def test_added_rows_and_actual_rows():
    diff = parse_unit_test_diff(ADDED)
    assert diff is not None
    assert diff.rows[1].status == "added" and diff.rows[1].expected is None
    assert diff.actual_rows() == [
        {"id": "1", "customer_name": "Ann", "state": "done", "amount": "3.0"},
        {"id": "2", "customer_name": None, "state": "back", "amount": "4.0"},
    ]


def test_empty_expect_lists_every_column():
    diff = parse_unit_test_diff(EMPTY_EXPECT)
    assert diff is not None
    assert diff.columns[-1] == "ordered_at"
    assert all(r.status == "added" for r in diff.rows)


def test_no_diff_in_message():
    assert parse_unit_test_diff(None) is None
    assert parse_unit_test_diff("Runtime Error\n  Binder Error: column x not found") is None
    assert parse_unit_test_diff("actual differs from expected:\n\nno table here") is None


def test_schema_change_row_is_flagged():
    message = "actual differs from expected:\n\n!  ,   ,+++\n@@ ,id ,extra\n+++,1  ,x\n"
    diff = parse_unit_test_diff(message)
    assert diff is not None and diff.schema_changed
    assert diff.columns == ("id", "extra")


def test_to_dict_shape():
    diff = parse_unit_test_diff(ADDED)
    assert diff is not None
    data = diff.to_dict()
    assert data["columns"] == ["id", "customer_name", "state", "amount"]
    assert data["rows"][1] == {"status": "added", "expected": None, "actual": ["2", None, "back", "4.0"]}


def test_coerce_uses_hints():
    assert coerce("4.0", 5) == 4
    assert coerce("4.5", 5) == 4.5
    assert coerce("4.0", 5.0) == 4.0 and isinstance(coerce("4.0", 5.0), float)
    assert coerce("007", "x") == "007"
    assert coerce("true", True) is True
    assert coerce("false") is False
    assert coerce(None, 1) is None
    assert coerce("done") == "done"
    assert coerce("12") == 12


# dbt 1.10.13: daff leaves unchanged rows out ("...") and prints actual-only dates as reprs
ELIDED = (
    "actual differs from expected:\n\n"
    "@@ ,id ,customer_name,state,amount,ordered_at\r\n"
    "...,...,...          ,...  ,...   ,...\r\n"
    "   ,3  ,Bob          ,done ,0.0   ,2024-01-03\r\n"
    "+++,4  ,null         ,open ,Decimal('5.0')   ,\"datetime.date(2024, 1, 4)\"\r\n"
)


def test_elided_rows_and_date_reprs():
    diff = parse_unit_test_diff(ELIDED)
    assert diff is not None and diff.elided
    assert [r.status for r in diff.rows] == ["same", "added"]
    assert diff.rows[1].actual == ("4", None, "open", "5.0", "2024-01-04")
    assert parse_unit_test_diff(ELIDED.replace("datetime.date(2024, 1, 4)", "datetime.datetime(2024, 1, 4, 9, 30)")).rows[1].actual[4] == "2024-01-04 09:30:00"
