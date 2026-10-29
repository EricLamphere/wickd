"""Add an `exposures:` entry to a dbt YAML file (pure; a dashboard's "Register as exposure").

Same contract as schema_saved_queries.py: ruamel.yaml only locates line positions, the
new lines are spliced in matching the file's indent style, and the result is re-parsed
and compared with the original plus the new entry before anything is written.
"""

import copy
import re
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

RESOURCE_KEY = "exposures"
_NAME = re.compile(r"^[a-z_][a-z0-9_]*$")
_METRIC_REF = re.compile(r"metric\('\w+'\)")


@dataclass(frozen=True)
class ExposureSpec:
    name: str
    owner: str
    metrics: tuple[str, ...]
    type: str = "dashboard"
    description: str | None = None
    dashboard_path: str | None = None  # meta.wickd_dashboard, so wickd can find the file again


def _depends(metric: str) -> str:
    return f"metric('{metric}')"


def _entry_lines(dash_col: int, offset: int, spec: ExposureSpec) -> list[str]:
    pad = " " * (dash_col + 2)
    inner = " " * (dash_col + 4)
    lines = [f"{' ' * dash_col}- name: {_scalar(spec.name)}\n", f"{pad}type: {_scalar(spec.type)}\n"]
    if spec.description:
        lines.append(f"{pad}description: {_scalar(spec.description)}\n")
    lines += [f"{pad}owner:\n", f"{inner}name: {_scalar(spec.owner)}\n", f"{pad}depends_on:\n"]
    lines += [f"{' ' * (dash_col + 2 + offset)}- {_depends(m)}\n" for m in spec.metrics]
    if spec.dashboard_path:
        lines += [f"{pad}meta:\n", f"{inner}wickd_dashboard: {_scalar(spec.dashboard_path)}\n"]
    return lines


def _expected_entry(spec: ExposureSpec) -> dict:
    entry: dict = {"name": spec.name, "type": spec.type}
    if spec.description:
        entry["description"] = spec.description
    entry["owner"] = {"name": spec.owner}
    entry["depends_on"] = [_depends(m) for m in spec.metrics]
    if spec.dashboard_path:
        entry["meta"] = {"wickd_dashboard": spec.dashboard_path}
    return entry


def _check(spec: ExposureSpec) -> None:
    if not _NAME.fullmatch(spec.name):
        raise SchemaYamlError("an exposure name must be lowercase letters, digits and underscores")
    if not spec.metrics:
        raise SchemaYamlError("an exposure needs at least one metric to depend on")
    if not spec.owner.strip():
        raise SchemaYamlError("an exposure needs an owner")
    bad = [m for m in spec.metrics if not _METRIC_REF.fullmatch(_depends(m))]
    if bad:
        raise SchemaYamlError(f"`{bad[0]}` isn't a valid metric name")


def add_exposure(text: str, filename: str, spec: ExposureSpec) -> str:
    """`text` with `spec` appended under `exposures:` (created at the end if missing)."""
    _check(spec)
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
                raise SchemaYamlError(f"{filename} already has an exposure named `{spec.name}`")
        dash_col = _dash_col(lines, entries, key_col + offset)
        new = _entry_lines(dash_col, offset, spec)
        if entries and _blank_between_entries(lines, entries):
            new = ["\n", *new]
        edit = _splice(lines, _after_content(lines, key_line, key_end), new, True, ())

    _verify(text, edit.text, filename, spec)
    return edit.text


def _blank_between_entries(lines: list[str], entries: list) -> bool:
    if len(entries) < 2:
        return False
    second = entries.lc.item(1)[0]
    return second > 0 and not lines[second - 1].strip()


def _verify(original: str, edited: str, filename: str, spec: ExposureSpec) -> None:
    expected = copy.deepcopy(_plain(_parse(original, filename)))
    if not original.strip():
        expected["version"] = 2
    expected[RESOURCE_KEY] = (expected.get(RESOURCE_KEY) or []) + [_expected_entry(spec)]
    try:
        actual = _plain(_parse(edited, filename))
    except SchemaYamlError as exc:
        raise SchemaYamlError(f"could not safely edit {filename}: {exc}") from exc
    if actual != expected:
        raise SchemaYamlError(f"could not safely edit {filename} — its layout is unusual; add the exposure by hand")
