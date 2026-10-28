"""Add a `saved_queries:` entry to a dbt YAML file (pure; the Metrics page's "Save as saved query").

Same contract as schema_yaml.py: ruamel.yaml only locates line positions, the new
lines are spliced in matching the file's indent style, and the result is re-parsed
and compared with the original plus the new entry before anything is written.
The `saved_queries:` shape is the same in both semantic-layer YAML specs.
"""

import copy
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from app.dbt.schema_yaml import (
    SchemaYamlError,
    _after_content,
    _dash_col,
    _key_bound,
    _parse,
    _plain,
    _require_block,
    _scalar,
    _seq_offset,
    _splice,
)

RESOURCE_KEY = "saved_queries"
_NAME = re.compile(r"^[a-z_][a-z0-9_]*$")
_PLAIN_TEMPLATE = re.compile(r"(?:Dimension|TimeDimension|Entity)\('\w+'(?:, '\w+')?\)")


@dataclass(frozen=True)
class SavedQuerySpec:
    name: str
    metrics: tuple[str, ...]
    group_by: tuple[str, ...] = ()  # YAML form: Dimension('a__b'), TimeDimension('metric_time', 'week')
    where: tuple[str, ...] = ()
    label: str | None = None
    description: str | None = None


def group_by_template(name: str, dimension_types: Mapping[str, str]) -> str:
    """A query group-by (`metric_time__week`, `customer__country`, `customer`) in saved-query form.

    `dimension_types` maps the catalog's dimension names to their type (time / categorical).
    """
    kind = dimension_types.get(name)
    if kind == "categorical":
        return f"Dimension('{name}')"
    if kind == "time" and not name.startswith("metric_time__"):
        return f"TimeDimension('{name}')"
    base, sep, grain = name.rpartition("__")
    is_time = sep and (
        dimension_types.get(base) == "time"
        or any(t == "time" and d.rpartition("__")[0] == base for d, t in dimension_types.items())
    )
    if is_time:
        return f"TimeDimension('{base}', '{grain}')"
    return f"Dimension('{name}')" if "__" in name else f"Entity('{name}')"


def _item(value: str) -> str:
    return value if _PLAIN_TEMPLATE.fullmatch(value) else _scalar(value)


def _list_lines(indent: int, offset: int, key: str, values: Sequence[str]) -> list[str]:
    if not values:
        return []
    return [f"{' ' * indent}{key}:\n", *(f"{' ' * (indent + offset)}- {_item(v)}\n" for v in values)]


def _entry_lines(dash_col: int, offset: int, spec: SavedQuerySpec) -> list[str]:
    key_col = dash_col + 2
    pad = " " * key_col
    lines = [f"{' ' * dash_col}- name: {_scalar(spec.name)}\n"]
    if spec.label:
        lines.append(f"{pad}label: {_scalar(spec.label)}\n")
    if spec.description:
        lines.append(f"{pad}description: {_scalar(spec.description)}\n")
    lines.append(f"{pad}query_params:\n")
    params = key_col + 2
    lines += _list_lines(params, offset, "metrics", spec.metrics)
    lines += _list_lines(params, offset, "group_by", spec.group_by)
    lines += _list_lines(params, offset, "where", spec.where)
    return lines


def _expected_entry(spec: SavedQuerySpec) -> dict:
    entry: dict = {"name": spec.name}
    if spec.label:
        entry["label"] = spec.label
    if spec.description:
        entry["description"] = spec.description
    params: dict = {"metrics": list(spec.metrics)}
    if spec.group_by:
        params["group_by"] = list(spec.group_by)
    if spec.where:
        params["where"] = list(spec.where)
    entry["query_params"] = params
    return entry


def add_saved_query(text: str, filename: str, spec: SavedQuerySpec) -> str:
    """`text` with `spec` appended under `saved_queries:` (created at the end if missing)."""
    if not _NAME.fullmatch(spec.name):
        raise SchemaYamlError("a saved query name must be lowercase letters, digits and underscores")
    if not spec.metrics:
        raise SchemaYamlError("a saved query needs at least one metric")
    data = _parse(text, filename)
    lines = text.splitlines(keepends=True)
    offset = _seq_offset(text)
    file_end = len(lines)

    if RESOURCE_KEY not in data:
        lead = ["\n"] if text.strip() else ["version: 2\n", "\n"]
        edit = _splice(lines, file_end, lead + [f"{RESOURCE_KEY}:\n", *_entry_lines(offset, offset, spec)], True, ())
    else:
        key_line, key_col = data.lc.key(RESOURCE_KEY)
        key_end = _key_bound(data, RESOURCE_KEY, file_end)
        entries = data[RESOURCE_KEY]
        if entries is not None and not isinstance(entries, list):
            raise SchemaYamlError(f"`{RESOURCE_KEY}` in {filename} is not a list")
        if entries:
            _require_block(lines, key_line, f"`{RESOURCE_KEY}` in {filename}")
            if any(isinstance(e, dict) and e.get("name") == spec.name for e in entries):
                raise SchemaYamlError(f"{filename} already has a saved query named `{spec.name}`")
        dash_col = _dash_col(lines, entries, key_col + offset)
        new = _entry_lines(dash_col, offset, spec)
        if entries:
            new = ["\n", *new] if _blank_between_entries(lines, entries) else new
        edit = _splice(lines, _after_content(lines, key_line, key_end), new, True, ())

    _verify(text, edit.text, filename, spec)
    return edit.text


def _blank_between_entries(lines: list[str], entries: list) -> bool:
    """Whether the file separates saved queries with a blank line (keep its style)."""
    if len(entries) < 2:
        return False
    second = entries.lc.item(1)[0]
    return second > 0 and not lines[second - 1].strip()


def _verify(original: str, edited: str, filename: str, spec: SavedQuerySpec) -> None:
    expected = copy.deepcopy(_plain(_parse(original, filename)))
    if not original.strip():
        expected["version"] = 2  # a new file starts with `version: 2`
    expected[RESOURCE_KEY] = (expected.get(RESOURCE_KEY) or []) + [_expected_entry(spec)]
    try:
        actual = _plain(_parse(edited, filename))
    except SchemaYamlError as exc:
        raise SchemaYamlError(f"could not safely edit {filename}: {exc}") from exc
    if actual != expected:
        raise SchemaYamlError(f"could not safely edit {filename} — its layout is unusual; add the saved query by hand")
