"""Parse the actual-vs-expected table dbt prints when a unit test fails. Pure.

dbt (1.8+) renders a daff diff into run_results.json's `message`:

    actual differs from expected:

    @@ ,id ,customer_name,state,amount
       ,1  ,Ann          ,done ,3.0
    →  ,7→2,Zed→NULL     ,back ,5.0→4.0
    +++,2  ,null         ,back ,Decimal('4.0')
    ---,1  ,"a, b"       ,done ,Decimal('3.0')

The first column is daff's tag: blank = same row, `→` = changed (each changed
cell is `expected→actual`), `+++` = only in actual, `---` = only in expected.
`...` rows stand for unchanged rows daff left out (so the table is NOT the whole
actual output — see `elided`), and `!` rows mark a schema change. Cells are comma
separated, padded with spaces, and quoted when they contain a comma; actual-only
values may print as Python reprs (`Decimal('4.0')`, `datetime.date(2024, 1, 4)`).
With colors on, ANSI codes are mixed in; they're stripped first.
"""

import csv
import re
from dataclasses import dataclass
from datetime import date, datetime

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_DECIMAL = re.compile(r"^Decimal\('(.*)'\)$")
_DATETIME = re.compile(r"^datetime\.(date|datetime)\(([\d, ]+)\)$")
_NUMBER = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")
_ARROWS = ("→", "->")
HEADER_TAG = "@@"
MARKER = "differs from"


@dataclass(frozen=True)
class DiffRow:
    status: str  # same | changed | added (actual only) | removed (expected only)
    expected: tuple[str | None, ...] | None
    actual: tuple[str | None, ...] | None


@dataclass(frozen=True)
class UnitTestDiff:
    columns: tuple[str, ...]
    rows: tuple[DiffRow, ...]
    schema_changed: bool = False  # daff printed a `!` row: columns differ, not just values
    elided: bool = False  # daff left unchanged rows out (`...`)

    def to_dict(self) -> dict:
        return {
            "columns": list(self.columns),
            "rows": [
                {
                    "status": r.status,
                    "expected": None if r.expected is None else list(r.expected),
                    "actual": None if r.actual is None else list(r.actual),
                }
                for r in self.rows
            ],
            "schema_changed": self.schema_changed,
            "elided": self.elided,
        }

    def actual_rows(self) -> list[dict[str, str | None]]:
        """What the model produced, as rows keyed by column (expected-only rows dropped)."""
        return [dict(zip(self.columns, r.actual, strict=False)) for r in self.rows if r.actual is not None]


def _value(cell: str) -> str | None:
    text = cell.strip()
    if text in ("NULL", "null", "None"):
        return None
    match = _DECIMAL.match(text)
    if match:
        return match.group(1)
    match = _DATETIME.match(text)
    if match:
        try:
            parts = [int(p) for p in match.group(2).split(",") if p.strip()]
            if match.group(1) == "date":
                return date(*parts).isoformat()
            return datetime(*parts).isoformat(sep=" ")
        except (TypeError, ValueError):
            return text
    return text


def _split_change(cell: str) -> tuple[str | None, str | None] | None:
    for arrow in _ARROWS:
        if arrow in cell:
            before, after = cell.split(arrow, 1)
            return _value(before), _value(after)
    return None


def _cells(line: str) -> list[str]:
    try:
        return next(csv.reader([line], skipinitialspace=False))
    except (csv.Error, StopIteration):
        return line.split(",")


def _table_lines(message: str) -> list[str]:
    clean = _ANSI.sub("", message).replace("\r\n", "\n").replace("\r", "\n")
    lines = clean.split("\n")
    start = next((i for i, ln in enumerate(lines) if ln.lstrip().startswith(HEADER_TAG)), None)
    if start is None:
        return []
    # a `!` schema row sits just above the header
    if start > 0 and lines[start - 1].lstrip().startswith("!"):
        start -= 1
    return [ln for ln in lines[start:] if ln.strip()]


def parse_unit_test_diff(message: str | None) -> UnitTestDiff | None:
    """The diff in a failed unit test's message, or None when there isn't one
    (a compile or database error, a pass, an unrecognised format)."""
    if not message or MARKER not in _ANSI.sub("", message):
        return None
    lines = _table_lines(message)
    columns: tuple[str, ...] = ()
    rows: list[DiffRow] = []
    schema_changed = False
    elided = False
    for line in lines:
        cells = _cells(line)
        tag = cells[0].strip()
        if tag.startswith("!"):
            schema_changed = True
            continue
        if tag == HEADER_TAG:
            columns = tuple(c.strip() for c in cells[1:])
            continue
        if tag == "...":
            elided = True
            continue
        if not columns or tag == ":":
            continue
        row = _row(tag, cells[1:], len(columns))
        if row is not None:
            rows.append(row)
    if not columns:
        return None
    return UnitTestDiff(columns=columns, rows=tuple(rows), schema_changed=schema_changed, elided=elided)


def _row(tag: str, cells: list[str], width: int) -> DiffRow | None:
    padded = (cells + [""] * width)[:width]
    if tag in _ARROWS:
        expected: list[str | None] = []
        actual: list[str | None] = []
        for cell in padded:
            change = _split_change(cell)
            before, after = change if change is not None else (_value(cell), _value(cell))
            expected.append(before)
            actual.append(after)
        return DiffRow("changed", tuple(expected), tuple(actual))
    values = tuple(_value(c) for c in padded)
    if tag == "+++":
        return DiffRow("added", None, values)
    if tag == "---":
        return DiffRow("removed", values, None)
    if tag == "":
        return DiffRow("same", values, values)
    return None


def coerce(value: str | None, hint: object = None) -> object:
    """A diff cell back to a YAML value: numbers and booleans when the cell (or the
    expected value it replaces, `hint`) looks like one; text otherwise."""
    if value is None:
        return None
    boolean = value.lower() in ("true", "false")
    if boolean and (isinstance(hint, bool) or hint is None):
        return value.lower() == "true"
    if isinstance(hint, str):
        return value
    if _NUMBER.match(value):
        number = float(value)
        if isinstance(hint, float):
            return number
        return int(number) if number.is_integer() and "e" not in value.lower() else number
    return value
