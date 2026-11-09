"""Add a dbt unit test to a properties YAML file, or replace its expected rows. Pure.

Same approach as schema_tests.py: the file is never re-serialised. New lines are
spliced in using the file's own indentation, then the result is parsed again and
must equal the original plus exactly this change.

    add_unit_test(text, filename, item) → text with `item` appended to `unit_tests:`
        (the key is added at the end of the file when missing; text None = new file)
    replace_expect_rows(text, filename, test_name, rows) → text with that unit test's
        `expect.rows` replaced (dict-format expectations only)

`item` is a plain dict: {name, model, description?, given: [{input, rows, format?}],
expect: {rows, format?}, overrides?}. Rows are written as one flow mapping per row
(`- {id: 1, status: "completed"}`); `format: csv` rows as a literal block.
"""

import copy
import csv
import io
import json
import re
from typing import Any

from app.dbt.schema_yaml import (
    SchemaYamlError,
    _after_content,
    _find_entry,
    _key_bound,
    _parse,
    _plain,
    _require_block,
    _scalar,
    _seq_offset,
    _splice,
)

UNIT_TESTS_KEY = "unit_tests"
DEFAULT_OFFSET = 2
_FLOW_PLAIN = re.compile(r"[A-Za-z_][A-Za-z0-9_\-.@/]*")
_INPUT_PLAIN = re.compile(r"(ref|source)\([^:#]*\)|this")
_RESERVED = {"y", "n", "yes", "no", "on", "off", "true", "false", "null", "~"}


# ── rendering ────────────────────────────────────────────────────────────────


def _flow_value(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    if isinstance(value, (list, dict)):
        return json.dumps(json.dumps(value, ensure_ascii=False), ensure_ascii=False)
    text = str(value)
    if _FLOW_PLAIN.fullmatch(text) and text.lower() not in _RESERVED:
        return text
    return json.dumps(text, ensure_ascii=False)


def _flow_key(key: str) -> str:
    return key if _FLOW_PLAIN.fullmatch(key) and key.lower() not in _RESERVED else json.dumps(key)


def flow_row(row: dict) -> str:
    return "{" + ", ".join(f"{_flow_key(str(k))}: {_flow_value(v)}" for k, v in row.items()) + "}"


def _input_scalar(value: str) -> str:
    return value if _INPUT_PLAIN.fullmatch(value) else json.dumps(value)


def _csv_text(rows: list[dict]) -> str:
    columns = list(dict.fromkeys(k for row in rows for k in row))
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    for row in rows:
        writer.writerow(["" if row.get(c) is None else row.get(c) for c in columns])
    return buffer.getvalue()


def _rows_lines(rows: list[dict], fmt: str, key_col: int, offset: int) -> list[str]:
    pad = " " * key_col
    if not rows:
        return [f"{pad}rows: []\n"]
    if fmt == "csv":
        body = " " * (key_col + 2)
        return [f"{pad}rows: |\n"] + [f"{body}{line}\n" for line in _csv_text(rows).splitlines()]
    dash = " " * (key_col + offset)
    return [f"{pad}rows:\n"] + [f"{dash}- {flow_row(r)}\n" for r in rows]


def _clean(item: dict) -> dict:
    """The item as it reads back from YAML: `format: dict` (the default) left out."""
    def fixture(f: dict) -> dict:
        out = {k: v for k, v in f.items() if not (k == "format" and v == "dict")}
        if out.get("format") == "csv":
            out["rows"] = _csv_text(f.get("rows") or []) if f.get("rows") else []
        return out

    cleaned: dict = {"name": item["name"]}
    if item.get("description"):
        cleaned["description"] = item["description"]
    cleaned["model"] = item["model"]
    cleaned["given"] = [fixture(g) for g in item.get("given") or []]
    cleaned["expect"] = fixture(item.get("expect") or {"rows": []})
    if item.get("overrides"):
        cleaned["overrides"] = item["overrides"]
    return cleaned


def _overrides_lines(overrides: dict, col: int) -> list[str]:
    lines = [f"{' ' * col}overrides:\n"]
    for section, values in overrides.items():
        lines.append(f"{' ' * (col + 2)}{_scalar(str(section))}:\n")
        for k, v in (values or {}).items():
            lines.append(f"{' ' * (col + 4)}{_scalar(str(k))}: {_flow_value(v)}\n")
    return lines


def render_item(item: dict, dash_col: int, offset: int) -> list[str]:
    key_col = dash_col + 2
    pad = " " * key_col
    lines = [f"{' ' * dash_col}- name: {_scalar(item['name'])}\n"]
    if item.get("description"):
        lines.append(f"{pad}description: {json.dumps(item['description'], ensure_ascii=False)}\n")
    lines.append(f"{pad}model: {_scalar(item['model'])}\n")
    if item.get("overrides"):
        lines += _overrides_lines(item["overrides"], key_col)
    lines.append(f"{pad}given:\n")
    given_dash = key_col + offset
    for fixture in item.get("given") or []:
        lines.append(f"{' ' * given_dash}- input: {_input_scalar(str(fixture['input']))}\n")
        fmt = fixture.get("format") or "dict"
        if fmt != "dict":
            lines.append(f"{' ' * (given_dash + 2)}format: {fmt}\n")
        lines += _rows_lines(fixture.get("rows") or [], fmt, given_dash + 2, offset)
    expect = item.get("expect") or {}
    lines.append(f"{pad}expect:\n")
    fmt = expect.get("format") or "dict"
    if fmt != "dict":
        lines.append(f"{' ' * (key_col + 2)}format: {fmt}\n")
    lines += _rows_lines(expect.get("rows") or [], fmt, key_col + 2, offset)
    return lines


# ── adding ───────────────────────────────────────────────────────────────────


def _check(original: str | None, new_text: str, filename: str, expected: Any) -> str:
    try:
        actual = _plain(_parse(new_text, filename))
    except SchemaYamlError as exc:
        raise SchemaYamlError(f"could not safely edit {filename}: {exc}") from exc
    if actual != expected:
        raise SchemaYamlError(f"could not safely edit {filename} — its layout is unusual; add the unit test by hand")
    return new_text


def add_unit_test(text: str | None, filename: str, item: dict) -> str:
    if not item.get("name") or not item.get("model"):
        raise SchemaYamlError("a unit test needs a name and a model")
    if text is None or not text.strip():
        new_text = "version: 2\n\nunit_tests:\n" + "".join(render_item(item, DEFAULT_OFFSET, DEFAULT_OFFSET))
        return _check(text, new_text, filename, {"version": 2, UNIT_TESTS_KEY: [_plain(_clean(item))]})

    data = _parse(text, filename)
    lines = text.splitlines(keepends=True)
    offset = _seq_offset(text)
    expected = copy.deepcopy(_plain(data))
    existing = data.get(UNIT_TESTS_KEY)
    if isinstance(existing, list) and _find_entry(existing, item["name"]) is not None:
        raise SchemaYamlError(f"a unit test named {item['name']!r} is already in {filename}")

    if UNIT_TESTS_KEY not in data:
        block = ["\n", f"{UNIT_TESTS_KEY}:\n", *render_item(item, offset, offset)]
        edit = _splice(lines, len(lines), block, True, ())
    else:
        key_line, key_col = data.lc.key(UNIT_TESTS_KEY)
        key_end = _key_bound(data, UNIT_TESTS_KEY, len(lines))
        if existing is not None and not isinstance(existing, list):
            raise SchemaYamlError(f"`{UNIT_TESTS_KEY}` in {filename} is not a list")
        if existing is None:
            dash_col = key_col + offset
        else:
            _require_block(lines, key_line, f"`{UNIT_TESTS_KEY}` in {filename}")
            first = lines[existing.lc.item(0)[0]] if existing else ""
            dash_col = first.find("-") if existing and first.find("-") >= 0 else key_col + offset
        at = _after_content(lines, key_line, key_end)
        edit = _splice(lines, at, render_item(item, dash_col, offset), True, ())
    expected[UNIT_TESTS_KEY] = list(expected.get(UNIT_TESTS_KEY) or []) + [_plain(_clean(item))]
    return _check(text, edit.text, filename, expected)


# ── replacing expected rows ──────────────────────────────────────────────────


def _entry_bounds(data: Any, lines: list[str], name: str) -> tuple[Any, int]:
    entries = data.get(UNIT_TESTS_KEY)
    entry = _find_entry(entries, name) if isinstance(entries, list) else None
    if entry is None:
        raise SchemaYamlError(f"unit test {name!r} not found")
    index = entries.index(entry)
    end = entries.lc.item(index + 1)[0] if index + 1 < len(entries) else _key_bound(data, UNIT_TESTS_KEY, len(lines))
    return entry, end


def replace_expect_rows(text: str, filename: str, test_name: str, rows: list[dict]) -> str:
    data = _parse(text, filename)
    lines = text.splitlines(keepends=True)
    entry, entry_end = _entry_bounds(data, lines, test_name)
    expect = entry.get("expect")
    if not isinstance(expect, dict):
        raise SchemaYamlError(f"{test_name!r} has no expect: block")
    if (expect.get("format") or "dict") != "dict" or expect.get("fixture"):
        raise SchemaYamlError(f"{test_name!r} expects {expect.get('format') or 'fixture'} rows — update them by hand")
    if lines[entry.lc.key("expect")[0]].split(":", 1)[-1].strip().startswith("{"):
        raise SchemaYamlError("inline {…} expect blocks can't be edited — convert them to block style")
    expect_end = _key_bound(entry, "expect", entry_end)
    offset = _seq_offset(text)
    if "rows" in expect:
        rows_line, rows_col = expect.lc.key("rows")
        stop = _after_content(lines, rows_line, _key_bound(expect, "rows", expect_end))
    else:
        first = next(iter(expect))
        rows_line, rows_col = expect.lc.key(first)
        rows_line = stop = _after_content(lines, rows_line, expect_end)
    new = _rows_lines(rows, "dict", rows_col, offset)
    newline = "\r\n" if lines and lines[0].endswith("\r\n") else "\n"
    new_text = "".join(lines[:rows_line] + [ln.replace("\n", newline) for ln in new] + lines[stop:])

    expected = copy.deepcopy(_plain(data))
    target = _find_entry(expected[UNIT_TESTS_KEY], test_name)
    assert target is not None
    target["expect"]["rows"] = _plain(rows)
    return _check(text, new_text, filename, expected)
