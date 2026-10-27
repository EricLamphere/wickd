"""Test items for proposals: from ranked candidates, and back into YAML.

A test item is what a "tests" proposal stores per suggestion (see
app/ai/test_generation.py's summary): {key, column (None for a model-level
test), columns?, test, reason, evidence?, source: lineage | ai, values?, to?,
field?, failures, spec: {name, args}}. Batch proposals (Test gaps) also put
file, unique_id, name and resource_key on each item, since they span files.

render_tests() is the one way a node's tests become YAML — for the first
build and for partial accept (app/ai/selection.py) alike.
"""

from collections.abc import Iterable

from app.dbt.schema_tests import DataTestSpec, add_column_tests, add_model_tests
from app.dbt.schema_yaml import node_text

COMBINATION = "unique_combination_of_columns"
COMBINATION_MACRO = "dbt_utils.unique_combination_of_columns"
LINEAGE_SOURCE = "lineage"


def structural_tests(rows: Iterable[dict], columns: list[str] | None = None) -> list[dict]:
    """Evidence-backed tests from rank_test_targets rows. With `columns` (the model's
    real columns), names are matched case-insensitively and unknown ones dropped."""
    by_lower = {c.lower(): c for c in columns} if columns is not None else None

    def name(column: str) -> str | None:
        return column if by_lower is None else by_lower.get(column.lower())

    tests: list[dict] = []
    for row in rows:
        for candidate in row.get("candidates") or []:
            evidence = candidate.get("evidence") or ""
            base = {"reason": evidence, "evidence": evidence, "source": LINEAGE_SOURCE}
            if candidate["test"] == COMBINATION:
                members = [name(c) for c in candidate.get("combination") or []]
                if len(members) > 1 and all(members):
                    tests.append({**base, "column": None, "columns": members, "test": COMBINATION})
                continue
            column = name(row.get("column") or "")
            if not column:
                continue
            test = {**base, "column": column, "test": candidate["test"]}
            if candidate["test"] == "relationships":
                test |= {"to": candidate["to"], "field": candidate["field"]}
            tests.append(test)
    return tests


def suggestion_key(test: dict) -> tuple[str, str]:
    """(column or "(a, b)", test) — what makes two suggestions the same."""
    column = test.get("column")
    label = column.lower() if column else "(" + ", ".join(c.lower() for c in test.get("columns") or []) + ")"
    return label, test["test"]


def render_tests(
    original: str | None,
    filename: str,
    resource_key: str,
    name: str,
    tests: Iterable[dict],
    dbt_version: str | None,
) -> str:
    """`original` (None → a new file) with the node's entry, its tested columns and `tests`."""
    by_column: dict[str, list[DataTestSpec]] = {}
    model_level: list[DataTestSpec] = []
    for test in tests:
        spec = DataTestSpec(test["spec"]["name"], test["spec"]["args"])
        if test.get("column"):
            by_column.setdefault(test["column"], []).append(spec)
        else:
            model_level.append(spec)
    text = node_text(original, filename, resource_key, name, list(by_column))
    if by_column:
        text = add_column_tests(text, filename, resource_key, name, by_column, dbt_version)
    if model_level:
        text = add_model_tests(text, filename, resource_key, name, model_level, dbt_version)
    return text
