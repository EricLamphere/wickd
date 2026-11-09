"""Accept a failing unit test's actual rows as its new expectation (plan 19, Base).

dbt's diff (app/dbt/unit_test_diff.py) leaves unchanged rows out (`...`), so the new
expectation is the test's current `expect.rows` with the diff applied: rows only in
expected removed, changed rows replaced by their actual values, rows only in actual
added; rows the diff left out are unchanged by definition and stay. Cells come back as
text; each is turned back into a number / boolean when the value it replaces (or the
cell itself) looks like one.
"""

from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from app.ai.documentation import FileChange
from app.dbt.manifest import UnitTestRef
from app.dbt.schema_unit_tests import replace_expect_rows
from app.dbt.schema_yaml import SchemaYamlError, _inside, _read
from app.dbt.unit_test_diff import UnitTestDiff, coerce

KIND = "unit_test_rebaseline"


class RebaselineError(Exception):
    """The expectation can't be replaced automatically (user-facing reason)."""


@dataclass(frozen=True)
class Rebaseline:
    change: FileChange
    summary: dict


def _hints(expected_rows: list) -> dict[str, object]:
    hints: dict[str, object] = {}
    for row in expected_rows:
        if not isinstance(row, dict):
            continue
        for column, value in row.items():
            if value is not None and str(column).lower() not in hints:
                hints[str(column).lower()] = value
    return hints


def _same(value: object, cell: str | None) -> bool:
    if cell is None or value is None:
        return cell is None and value is None
    if isinstance(value, bool):
        return str(value).lower() == cell.lower()
    if isinstance(value, (int, float)):
        try:
            return float(value) == float(cell)
        except ValueError:
            return False
    return str(value).strip() == cell.strip()


def _lookup(row: dict, column: str) -> object:
    if column in row:
        return row[column]
    return next((v for k, v in row.items() if str(k).lower() == column.lower()), None)


def _find(rows: list[dict], used: set[int], columns: tuple[str, ...], cells: tuple[str | None, ...]) -> int | None:
    for i, row in enumerate(rows):
        if i not in used and all(_same(_lookup(row, c), cell) for c, cell in zip(columns, cells, strict=False)):
            return i
    return None


def actual_rows(diff: UnitTestDiff, expected_rows: list) -> list[dict]:
    """The rows the model produced, built from the current expectation plus the diff."""
    hints = _hints(expected_rows)
    rows: list[dict | None] = [dict(r) for r in expected_rows if isinstance(r, dict)]
    present = [r for r in rows if r is not None]
    used: set[int] = set()
    added: list[dict] = []

    def typed(cells: tuple[str | None, ...]) -> dict:
        return {c: coerce(v, hints.get(c.lower())) for c, v in zip(diff.columns, cells, strict=False)}

    for row in diff.rows:
        if row.status == "added" and row.actual is not None:
            added.append(typed(row.actual))
            continue
        if row.expected is None:
            continue
        index = _find(present, used, diff.columns, row.expected)
        if index is None:
            if row.status == "changed" and row.actual is not None:
                added.append(typed(row.actual))
            continue
        used.add(index)
        if row.status == "removed":
            rows[index] = None
        elif row.status == "changed" and row.actual is not None:
            rows[index] = {**present[index], **typed(row.actual)}
    return [r for r in rows if r is not None] + added


def build_rebaseline(project_path: Path, unit: UnitTestRef, diff: UnitTestDiff) -> Rebaseline:
    if diff.schema_changed:
        raise RebaselineError("the actual output has different columns than the test expects — update it by hand")
    if not unit.original_file_path:
        raise RebaselineError("the unit test's file isn't known — re-parse the project")
    expect = unit.expect or {}
    if (expect.get("format") or "dict") != "dict" or expect.get("fixture"):
        raise RebaselineError(f"{unit.name} expects {expect.get('format') or 'fixture'} rows — update them by hand")
    old_rows = expect.get("rows") if isinstance(expect.get("rows"), list) else []
    rows = actual_rows(diff, old_rows)

    root = project_path.resolve()
    try:
        path = _inside(root, unit.original_file_path)
        original = _read(path)
        text = replace_expect_rows(original, PurePosixPath(unit.original_file_path).name, unit.name, rows)
    except SchemaYamlError as exc:
        raise RebaselineError(str(exc)) from exc
    columns = list(diff.columns)
    summary = {
        "unit_test": {"name": unit.name, "model": unit.model, "file": unit.original_file_path},
        "rebaseline": True,
        "expected": {"columns": columns, "rows": [[r.get(c) for c in columns] for r in old_rows if isinstance(r, dict)]},
        "actual": {"columns": columns, "rows": [[r.get(c) for c in columns] for r in rows]},
    }
    return Rebaseline(FileChange(unit.original_file_path, original, text), summary)
