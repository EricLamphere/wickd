"""Add tags to a node's columns in schema YAML text.

Same approach as schema_tests.py: text is never re-serialised — lines are
spliced in (in the file's own indentation) and the result is re-parsed and
checked against the original plus exactly these tags. Pure.

Tags go wherever the column already keeps them: `config: tags:` (dbt 1.10+
style) or a top-level `tags:`, as a block list, a one-line `[...]` list or a
single string. A column without tags gets a one-line `tags: [...]`. Tags the
column already has (any case) are skipped.
"""

import copy
import re
from collections.abc import Mapping, Sequence

from ruamel.yaml.comments import CommentedMap

from app.dbt.schema_descriptions import _apply, _Splice
from app.dbt.schema_yaml import (
    SchemaYamlError,
    _after_content,
    _find_entry,
    _key_bound,
    _parse,
    _plain,
    _scalar,
    _seq_offset,
)

_FLOW = re.compile(r"^(?P<head>[^#]*?\[)(?P<items>[^\]#]*)(?P<tail>\].*)$", re.DOTALL)


def _tags_home(column: CommentedMap) -> CommentedMap:
    """The mapping holding the column's tags: its `config:` when tags live there."""
    config = column.get("config")
    if isinstance(config, CommentedMap) and "tags" in config:
        return config
    return column


def _existing(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(v) for v in value]
    raise SchemaYamlError("`tags` is neither a list nor a string")


def add_column_tags(
    text: str,
    filename: str,
    resource_key: str,
    name: str,
    tags: Mapping[str, Sequence[str]],
) -> str:
    """Add `tags` (column name → tags) to the node's columns. Columns must already exist."""
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
    wanted = {k.lower(): list(dict.fromkeys(v)) for k, v in tags.items() if v}

    splices: list[_Splice] = []
    applied: dict[str, list[str]] = {}
    for i, column in enumerate(columns):
        if not isinstance(column, CommentedMap) or "name" not in column:
            continue
        home = _tags_home(column)
        have = {t.lower() for t in _existing(home.get("tags"))}
        new = [t for t in wanted.get(str(column["name"]).lower(), []) if t.lower() not in have]
        if not new:
            continue
        col_end = columns.lc.item(i + 1)[0] if i + 1 < len(columns) else cols_end
        splices.append(_plan_column(lines, column, home, col_end, new, offset))
        applied[str(column["name"])] = new

    if not splices:
        return text
    new_text = _apply(lines, splices)
    _verify(text, new_text, filename, resource_key, name, applied)
    return new_text


def _plan_column(
    lines: list[str],
    column: CommentedMap,
    home: CommentedMap,
    col_end: int,
    new: list[str],
    offset: int,
) -> _Splice:
    name_line, key_col = column.lc.key("name")
    if lines[name_line].lstrip().lstrip("- ").startswith("{"):
        raise SchemaYamlError("inline {…} columns can't be edited — convert them to block style")

    if "tags" not in home:
        at = _after_content(lines, name_line, col_end)
        rendered = ", ".join(_scalar(t) for t in new)
        return _Splice(at, at, (f"{' ' * key_col}tags: [{rendered}]\n",))

    key_line, col = home.lc.key("tags")
    existing = home["tags"]
    line = lines[key_line]
    value = line.split(":", 1)[1] if ":" in line else ""

    if isinstance(existing, list) and existing and not value.strip().startswith("["):
        dash = lines[existing.lc.item(0)[0]].find("-")
        dash_col = dash if dash >= 0 else col + offset
        at = _after_content(lines, key_line, _key_bound(home, "tags", col_end))
        return _Splice(at, at, tuple(f"{' ' * dash_col}- {_scalar(t)}\n" for t in new))
    if existing is None:
        return _Splice(
            key_line + 1, key_line + 1, tuple(f"{' ' * (col + offset)}- {_scalar(t)}\n" for t in new)
        )
    if isinstance(existing, list):  # one-line [...]
        match = _FLOW.match(value)
        if match is None:
            raise SchemaYamlError(f"`tags` for {column['name']!r} spans several lines — add the tags by hand")
        items = match["items"].strip()
        added = ", ".join(_scalar(t) for t in new)
        joined = f"{items}, {added}" if items else added
        rebuilt = f"{line.split(':', 1)[0]}:{match['head']}{joined}{match['tail']}"
        return _Splice(key_line, key_line + 1, (rebuilt,))
    # a single string: turn it into a one-line list
    comment = ""
    if "#" in value:
        value, comment = value.split("#", 1)
        comment = "  #" + comment.rstrip("\r\n")
    rendered = ", ".join(_scalar(t) for t in [str(existing), *new])
    return _Splice(key_line, key_line + 1, (f"{line.split(':', 1)[0]}: [{rendered}]{comment}\n",))


def _verify(
    original: str,
    new_text: str,
    filename: str,
    resource_key: str,
    name: str,
    applied: Mapping[str, list[str]],
) -> None:
    expected = copy.deepcopy(_plain(_parse(original, filename)))
    entry = _find_entry(expected[resource_key], name)
    assert entry is not None
    for column in entry.get("columns") or []:
        if not isinstance(column, dict) or str(column.get("name")) not in applied:
            continue
        config = column.get("config")
        home = config if isinstance(config, dict) and "tags" in config else column
        home["tags"] = _existing(home.get("tags")) + applied[str(column["name"])]
    try:
        actual = _plain(_parse(new_text, filename))
    except SchemaYamlError as exc:
        raise SchemaYamlError(f"could not safely edit {filename}: {exc}") from exc
    if actual != expected:
        raise SchemaYamlError(
            f"could not safely edit {filename} — its layout is unusual; add the tags by hand"
        )
