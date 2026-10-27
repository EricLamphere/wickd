"""Set `description:` values on a node and its columns in schema YAML text.

Same approach as schema_yaml.py: the text is never re-serialised. ruamel.yaml
locates each mapping's lines, description lines are inserted or replaced in
the file's own indentation, and the result is re-parsed and compared against
the original plus exactly these changes before it is returned. Pure — the
caller decides whether (and when) to write the text.
"""

import copy
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass

from ruamel.yaml.comments import CommentedMap

from app.dbt.schema_yaml import (
    SchemaYamlError,
    _after_content,
    _find_entry,
    _key_bound,
    _parse,
    _plain,
)

# A plain YAML scalar is only safe without characters YAML treats specially.
_PLAIN_SAFE = re.compile(r"[A-Za-z][A-Za-z0-9 _.,()'/-]*[A-Za-z0-9.)]")
_RESERVED = {"y", "n", "yes", "no", "on", "off", "true", "false", "null"}


@dataclass(frozen=True)
class DescriptionChanges:
    text: str
    node: bool  # node description set
    columns: tuple[str, ...]  # columns whose description was set

    @property
    def changed(self) -> bool:
        return self.node or bool(self.columns)


@dataclass(frozen=True)
class ExistingDescriptions:
    node: bool  # the node already has a non-empty description
    columns: frozenset[str]  # lower-cased names of columns that already have one


def existing_descriptions(
    text: str, filename: str, resource_key: str, name: str
) -> ExistingDescriptions:
    """What's already described, so callers only ask a model for what's missing."""
    entries = _parse(text, filename).get(resource_key)
    entry = _find_entry(entries, name) if isinstance(entries, list) else None
    if entry is None:
        return ExistingDescriptions(node=False, columns=frozenset())
    described = frozenset(
        str(c["name"]).lower()
        for c in entry.get("columns") or []
        if isinstance(c, dict) and "name" in c and not _wants(c, overwrite=False)
    )
    return ExistingDescriptions(node=not _wants(entry, overwrite=False), columns=described)


def raw_descriptions(text: str, filename: str, resource_key: str, name: str) -> dict[str, str]:
    """Column name → its description exactly as written in the YAML (so a
    `{{ doc('…') }}` stays a doc block, unlike the manifest's rendered text)."""
    entries = _parse(text, filename).get(resource_key)
    entry = _find_entry(entries, name) if isinstance(entries, list) else None
    return _column_descriptions(entry)


def raw_source_descriptions(text: str, filename: str, source_name: str, table: str) -> dict[str, str]:
    """raw_descriptions() for a source table (`sources: - name: … tables: - name: …`)."""
    sources = _parse(text, filename).get("sources")
    source = _find_entry(sources, source_name) if isinstance(sources, list) else None
    tables = source.get("tables") if source is not None else None
    return _column_descriptions(_find_entry(tables, table) if isinstance(tables, list) else None)


def _column_descriptions(entry: dict | None) -> dict[str, str]:
    if entry is None:
        return {}
    return {
        str(c["name"]): str(c["description"])
        for c in entry.get("columns") or []
        if isinstance(c, dict) and "name" in c and not _wants(c, overwrite=False)
    }


@dataclass(frozen=True)
class _Splice:
    start: int
    end: int  # == start for a pure insertion
    lines: tuple[str, ...]


def set_descriptions(
    text: str,
    filename: str,
    resource_key: str,
    name: str,
    node_description: str | None,
    column_descriptions: Mapping[str, str],
    *,
    overwrite: bool = False,
) -> DescriptionChanges:
    """Fill in (or with `overwrite`, replace) descriptions for `name` and its columns.

    The node's entry (and any columns to describe) must already be in `text` —
    run schema_yaml.plan_document_node() first.
    """
    data = _parse(text, filename)
    lines = text.splitlines(keepends=True)
    entries = data.get(resource_key)
    if not isinstance(entries, list):
        raise SchemaYamlError(f"`{resource_key}` in {filename} is not a list")
    index = next(
        (i for i, e in enumerate(entries) if isinstance(e, dict) and e.get("name") == name), None
    )
    if index is None:
        raise SchemaYamlError(f"{name!r} is not in {filename}")
    entry = entries[index]
    entry_end = (
        entries.lc.item(index + 1)[0]
        if index + 1 < len(entries)
        else _key_bound(data, resource_key, len(lines))
    )

    splices: list[_Splice] = []
    node_set = False
    clean = _clean(node_description)
    if clean and _wants(entry, overwrite):
        splices.append(_plan(lines, entry, entry_end, clean))
        node_set = True

    described = _plan_columns(lines, entry, entry_end, column_descriptions, overwrite, splices)
    if not splices:
        return DescriptionChanges(text, node=False, columns=())

    new_text = _apply(lines, splices)
    _verify(text, new_text, filename, resource_key, name, clean if node_set else None, described)
    return DescriptionChanges(new_text, node=node_set, columns=tuple(described))


def _plan_columns(
    lines: list[str],
    entry: CommentedMap,
    entry_end: int,
    column_descriptions: Mapping[str, str],
    overwrite: bool,
    splices: list[_Splice],
) -> dict[str, str]:
    columns = entry.get("columns")
    if not isinstance(columns, list) or not column_descriptions:
        return {}
    wanted = {k.lower(): _clean(v) for k, v in column_descriptions.items()}
    cols_end = _key_bound(entry, "columns", entry_end)
    described: dict[str, str] = {}
    for i, column in enumerate(columns):
        if not isinstance(column, CommentedMap) or "name" not in column:
            continue
        col_name = str(column["name"])
        value = wanted.get(col_name.lower())
        if not value or not _wants(column, overwrite):
            continue
        col_end = columns.lc.item(i + 1)[0] if i + 1 < len(columns) else cols_end
        splices.append(_plan(lines, column, col_end, value))
        described[col_name] = value
    return described


def _clean(value: str | None) -> str:
    return " ".join((value or "").split())


def _wants(mapping: CommentedMap, overwrite: bool) -> bool:
    existing = mapping.get("description")
    return overwrite or not (isinstance(existing, str) and existing.strip())


def _plan(lines: list[str], mapping: CommentedMap, mapping_end: int, value: str) -> _Splice:
    if "name" not in mapping:
        raise SchemaYamlError("found an entry without a name")
    name_line, col = mapping.lc.key("name")
    if lines[name_line].lstrip().lstrip("- ").startswith("{"):
        raise SchemaYamlError("inline {…} entries can't be edited — convert them to block style")
    if "description" in mapping:
        start, col = mapping.lc.key("description")
        bound = _key_bound(mapping, "description", mapping_end)
        # keep whatever precedes the key — `- ` when description is the entry's first key
        prefix = lines[start][:col]
        return _Splice(start, _after_content(lines, start, bound), (_line(prefix, value),))
    at = _after_content(lines, name_line, _key_bound(mapping, "name", mapping_end))
    return _Splice(at, at, (_line(" " * col, value),))


def _scalar(value: str) -> str:
    if _PLAIN_SAFE.fullmatch(value) and value.lower() not in _RESERVED:
        return value
    return json.dumps(value, ensure_ascii=False)  # a JSON string is valid double-quoted YAML


def _line(prefix: str, value: str) -> str:
    return f"{prefix}description: {_scalar(value)}\n"


def _apply(lines: list[str], splices: list[_Splice]) -> str:
    newline = "\r\n" if lines and lines[0].endswith("\r\n") else "\n"
    result = list(lines)
    for splice in sorted(splices, key=lambda s: s.start, reverse=True):
        if splice.start > 0 and not result[splice.start - 1].endswith(("\n", "\r")):
            result[splice.start - 1] += newline
        result[splice.start:splice.end] = [ln.replace("\n", newline) for ln in splice.lines]
    return "".join(result)


def _verify(
    original: str,
    new_text: str,
    filename: str,
    resource_key: str,
    name: str,
    node_description: str | None,
    columns: Mapping[str, str],
) -> None:
    expected = copy.deepcopy(_plain(_parse(original, filename)))
    entry = _find_entry(expected[resource_key], name)
    assert entry is not None
    if node_description is not None:
        entry["description"] = node_description
    for column in entry.get("columns") or []:
        if isinstance(column, dict) and str(column.get("name")) in columns:
            column["description"] = columns[str(column["name"])]
    try:
        actual = _plain(_parse(new_text, filename))
    except SchemaYamlError as exc:
        raise SchemaYamlError(f"could not safely edit {filename}: {exc}") from exc
    if actual != expected:
        raise SchemaYamlError(
            f"could not safely edit {filename} — its layout is unusual; add the descriptions by hand"
        )
