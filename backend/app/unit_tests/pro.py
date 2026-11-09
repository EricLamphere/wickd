"""Unit test generation — wickd Pro. Public shim over the private `wickd_pro.unit_tests`.

Same split as app/test_targets/pro.py: which rows to sample, the sampling SQL and the
rewrite that computes the expected rows live in wickd_pro; running the queries, the
YAML writer, the proposal and the UI are public. Plain dicts only (see the contract
in wickd_pro/unit_tests/__init__.py):

    plan_unit_test(sql, adapter_type, inputs, focus, this_relation) → plan (refusal?)
    focus_options(sql, adapter_type, inputs) → [{id, label, kind}]
    next_queries(plan, inputs, fixtures) → {input: sql}
    pick_rows(columns, rows) → [row]
    mask_fixtures(plan, fixtures) → fixtures
    expectation_sql(plan, sql, inputs, fixtures) → sql   (raises ValueError subclass)
    expect_columns(plan, focus) → [column]
    build_item(**fields) → unit_tests entry
"""

from typing import Any


class UnitTestsUnavailable(Exception):
    """wickd_pro (with unit test generation) isn't installed in this build."""


UNAVAILABLE = "Unit test generation requires the wickd Pro package, which isn't installed in this build."


def _pro() -> Any:
    try:
        from wickd_pro import unit_tests
    except ImportError as exc:
        raise UnitTestsUnavailable(UNAVAILABLE) from exc
    return unit_tests


def is_available() -> bool:
    try:
        _pro()
    except UnitTestsUnavailable:
        return False
    return True


def plan_unit_test(
    sql: str, adapter_type: str | None, inputs: list[dict], focus: str | None, this_relation: str | None
) -> dict:
    return _pro().plan_unit_test(sql, adapter_type, inputs, focus, this_relation)


def focus_options(sql: str, adapter_type: str | None, inputs: list[dict]) -> list[dict]:
    return _pro().focus_options(sql, adapter_type, inputs)


def next_queries(plan: dict, inputs: list[dict], fixtures: dict[str, list[dict]]) -> dict[str, str]:
    return _pro().next_queries(plan, inputs, fixtures)


def pick_rows(columns: list[str], rows: list[list]) -> list[dict]:
    return _pro().pick_rows(columns, rows)


def mask_fixtures(plan: dict, fixtures: dict[str, list[dict]]) -> dict[str, list[dict]]:
    return _pro().mask_fixtures(plan, fixtures)


def expectation_sql(plan: dict, sql: str, inputs: list[dict], fixtures: dict[str, list[dict]]) -> str:
    """Raises ValueError when the model's SQL can't be rewritten."""
    pro = _pro()
    try:
        return pro.expectation_sql(plan, sql, inputs, fixtures)
    except pro.AnalysisError as exc:
        raise ValueError(str(exc)) from exc


def expect_columns(plan: dict, focus: str | None) -> list[str]:
    return _pro().expect_columns(plan, focus)


def build_item(**fields: Any) -> dict:
    return _pro().build_item(**fields)
