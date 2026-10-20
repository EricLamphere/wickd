"""Add generic data tests to a node's columns in schema YAML text.

Same approach as schema_descriptions.py: text is never re-serialised — lines
are spliced in (in the file's own indentation) and the result is re-parsed and
checked against the original plus exactly these tests. Pure.

Uses the column's existing test key (`data_tests:` or the pre-1.8 `tests:`),
else the one this entry already uses elsewhere, else the dbt version's default.
dbt 1.10+ wants test arguments under `arguments:`.
"""

import copy
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from ruamel.yaml.comments import CommentedMap

from app.dbt.schema_descriptions import _apply, _Splice
from app.dbt.schema_yaml import (
    SchemaYamlError,
    _after_content,
    _find_entry,
    _key_bound,
    _parse,
    _plain,
    _seq_offset,
)

TEST_KEYS = ("data_tests", "tests")


@dataclass(frozen=True)
class DataTestSpec:
    name: str  # not_null | unique | accepted_values | relationships
    args: dict = field(default_factory=dict)  # values / quote / to / field


def _version(dbt_version: str | None) -> tuple[int, int]:
    try:
        major, minor = (dbt_version or "").split(".")[:2]
        return int(major), int(minor)
    except ValueError:
        return (1, 8)


def default_test_key(dbt_version: str | None) -> str:
    return "data_tests" if _version(dbt_version) >= (1, 8) else "tests"


def uses_arguments_block(dbt_version: str | None) -> bool:
    return _version(dbt_version) >= (1, 10)


def _value(v: object) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return json.dumps(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_value(x) for x in v) + "]"
    return json.dumps(str(v), ensure_ascii=False)


def render_test(spec: DataTestSpec, dash_col: int, arguments_block: bool) -> list[str]:
    pad = " " * dash_col
    if not spec.args:
        return [f"{pad}- {spec.name}\n"]
    lines = [f"{pad}- {spec.name}:\n"]
    arg_col = dash_col + 4
    if arguments_block:
        lines.append(f"{' ' * arg_col}arguments:\n")
        arg_col += 2
    lines += [f"{' ' * arg_col}{k}: {_value(v)}\n" for k, v in spec.args.items()]
    return lines


def _plain_test(spec: DataTestSpec, arguments_block: bool) -> object:
    if not spec.args:
        return spec.name
    args = json.loads(json.dumps(spec.args))
    return {spec.name: {"arguments": args} if arguments_block else args}


def add_column_tests(
    text: str,
    filename: str,
    resource_key: str,
    name: str,
    tests: Mapping[str, Sequence[DataTestSpec]],
    dbt_version: str | None,
) -> str:
    """Append `tests` (column name → specs) to the node's columns. Columns must already exist."""
    data = _parse(text, filename)
    lines = text.splitlines(keepends=True)
    entries = data.get(resource_key)
    entry = _find_entry(entries, name) if isinstance(entries, list) else None
    if entry is None:
        raise SchemaYamlError(f"{name!r} is not in {filename}")
    columns = entry.get("columns")
    if not isinstance(columns, list):
        raise SchemaYamlError(f"{name!r} has no columns list in {filename}")

    index = entries.index(entry)
    entry_end = (
        entries.lc.item(index + 1)[0]
        if index + 1 < len(entries)
        else _key_bound(data, resource_key, len(lines))
    )
    cols_end = _key_bound(entry, "columns", entry_end)
    offset = _seq_offset(text)
    entry_key = next((k for c in columns if isinstance(c, dict) for k in TEST_KEYS if k in c), None)
    fallback_key = entry_key or default_test_key(dbt_version)
    arguments_block = uses_arguments_block(dbt_version)
    wanted = {k.lower(): v for k, v in tests.items() if v}

    splices: list[_Splice] = []
    applied: dict[str, tuple[str, Sequence[DataTestSpec]]] = {}
    for i, column in enumerate(columns):
        if not isinstance(column, CommentedMap) or "name" not in column:
            continue
        specs = wanted.get(str(column["name"]).lower())
        if not specs:
            continue
        col_end = columns.lc.item(i + 1)[0] if i + 1 < len(columns) else cols_end
        key, splice = _plan_column(lines, column, col_end, specs, fallback_key, offset, arguments_block)
        splices.append(splice)
        applied[str(column["name"])] = (key, specs)

    if not splices:
        return text
    new_text = _apply(lines, splices)
    _verify(text, new_text, filename, resource_key, name, applied, arguments_block)
    return new_text


def _plan_column(
    lines: list[str],
    column: CommentedMap,
    col_end: int,
    specs: Sequence[DataTestSpec],
    fallback_key: str,
    offset: int,
    arguments_block: bool,
) -> tuple[str, _Splice]:
    name_line, key_col = column.lc.key("name")
    if lines[name_line].lstrip().lstrip("- ").startswith("{"):
        raise SchemaYamlError("inline {…} columns can't be edited — convert them to block style")
    key = next((k for k in TEST_KEYS if k in column), None)

    if key is None:
        at = _after_content(lines, name_line, col_end)
        new = [f"{' ' * key_col}{fallback_key}:\n"]
        for spec in specs:
            new += render_test(spec, key_col + offset, arguments_block)
        return fallback_key, _Splice(at, at, tuple(new))

    key_line, col = column.lc.key(key)
    existing = column[key]
    if existing is not None and not isinstance(existing, list):
        raise SchemaYamlError(f"`{key}` for {column['name']!r} is not a list")
    if lines[key_line].split(":", 1)[-1].strip().startswith("["):
        raise SchemaYamlError(f"`{key}` for {column['name']!r} uses inline [...] syntax")
    if existing:
        dash = lines[existing.lc.item(0)[0]].find("-")
        dash_col = dash if dash >= 0 else col + offset
        at = _after_content(lines, key_line, _key_bound(column, key, col_end))
    else:
        dash_col, at = col + offset, key_line + 1
    new: list[str] = []
    for spec in specs:
        new += render_test(spec, dash_col, arguments_block)
    return key, _Splice(at, at, tuple(new))


def _verify(
    original: str,
    new_text: str,
    filename: str,
    resource_key: str,
    name: str,
    applied: Mapping[str, tuple[str, Sequence[DataTestSpec]]],
    arguments_block: bool,
) -> None:
    expected = copy.deepcopy(_plain(_parse(original, filename)))
    entry = _find_entry(expected[resource_key], name)
    assert entry is not None
    for column in entry.get("columns") or []:
        if not isinstance(column, dict) or str(column.get("name")) not in applied:
            continue
        key, specs = applied[str(column["name"])]
        column[key] = (column.get(key) or []) + [_plain_test(s, arguments_block) for s in specs]
    try:
        actual = _plain(_parse(new_text, filename))
    except SchemaYamlError as exc:
        raise SchemaYamlError(f"could not safely edit {filename}: {exc}") from exc
    if actual != expected:
        raise SchemaYamlError(
            f"could not safely edit {filename} — its layout is unusual; add the tests by hand"
        )
