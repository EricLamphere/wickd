from app.dbt.drift import diff_columns
from app.dbt.manifest import ColumnInfo


def _col(name: str, data_type: str = "") -> ColumnInfo:
    return ColumnInfo(name=name, description="", data_type=data_type)


def test_warehouse_types_are_attached_by_column_name_case_insensitively():
    result = diff_columns((_col("ID", "int"),), ("id", "amount"), ("INTEGER", "DECIMAL(10,2)"))
    by_name = {c.name: c for c in result}
    assert by_name["ID"].warehouse_type == "INTEGER"
    assert by_name["amount"].warehouse_type == "DECIMAL(10,2)"


def test_differing_types_are_shown_but_not_flagged_yet():
    (col,) = diff_columns((_col("id", "varchar"),), ("id",), ("INTEGER",))
    assert col.manifest_type == "varchar" and col.warehouse_type == "INTEGER"
    assert not col.type_mismatch


def test_without_types_warehouse_type_is_empty():
    (col,) = diff_columns((), ("id",))
    assert col.warehouse_type == ""
    assert col.in_warehouse and not col.in_manifest


def test_manifest_only_column_has_no_warehouse_type():
    (col,) = diff_columns((_col("gone", "text"),), (), ())
    assert col.manifest_type == "text" and col.warehouse_type == ""
