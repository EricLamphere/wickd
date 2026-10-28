"""Write a drafted semantic model + metrics into dbt YAML (pure; Wicky's semantic drafts).

Same contract as schema_yaml.py: ruamel.yaml only locates line positions, new lines are
spliced into the original text in the file's indent style, and the result is re-parsed
and compared with the original plus exactly the additions before it's used. Existing
text is never re-serialised.

`items` is wickd_pro's to_yaml_items() output; `keys` the items to include
("semantic_model", "metric:<name>"), so a proposal can be rebuilt for a subset.

legacy: entries appended to top-level `semantic_models:` and `metrics:` lists.
latest: `semantic_model:` / `agg_time_dimension` / `metrics:` added to the model's entry,
        `entity:` / `dimension:` / `granularity:` to its column entries (created when
        missing), ratio metrics appended to top-level `metrics:`.
"""

import copy
import json
import re
from collections.abc import Iterable
from typing import Any

from ruamel.yaml.comments import CommentedMap

from app.dbt.schema_yaml import (
    SchemaYamlError,
    _after_content,
    _dash_col,
    _key_bound,
    _parse,
    _plain,
    _require_block,
    _seq_offset,
    _splice,
    node_text,
)

SEMANTIC_MODEL_KEY = "semantic_model"
METRIC_PREFIX = "metric:"
_PLAIN = re.compile(r"[A-Za-z_][A-Za-z0-9_ ()'.,/=-]*")
_RESERVED = {"y", "n", "yes", "no", "on", "off", "true", "false", "null", "~"}


# ── a tiny block-style emitter for new entries (never used on existing text) ──


def _scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if _PLAIN.fullmatch(text) and text.lower() not in _RESERVED and not text.endswith(" ") and "  " not in text:
        return text
    return json.dumps(text)  # a JSON string is a valid double-quoted YAML scalar


def _mapping_lines(mapping: dict, indent: int, offset: int) -> list[str]:
    pad = " " * indent
    lines: list[str] = []
    for key, value in mapping.items():
        if isinstance(value, dict):
            lines.append(f"{pad}{key}:\n")
            lines += _mapping_lines(value, indent + 2, offset)
        elif isinstance(value, list):
            lines.append(f"{pad}{key}:\n")
            lines += _sequence_lines(value, indent + offset, offset)
        else:
            lines.append(f"{pad}{key}: {_scalar(value)}\n")
    return lines


def _sequence_lines(items: list, dash_col: int, offset: int) -> list[str]:
    lines: list[str] = []
    for item in items:
        if isinstance(item, dict):
            body = _mapping_lines(item, dash_col + 2, offset)
            lines.append(" " * dash_col + "- " + body[0].lstrip(" "))
            lines += body[1:]
        else:
            lines.append(f"{' ' * dash_col}- {_scalar(item)}\n")
    return lines


# ── which items survive a selection ──────────────────────────────────────────


def chosen_metrics(items: dict, keys: Iterable[str]) -> list[dict]:
    """Metric items in `keys` whose inputs stay available.

    Without the semantic model, its simple metrics go too (they need its measures or
    columns); a ratio needs both inputs — a kept draft metric or one that already exists.
    """
    keys = set(keys)
    keep_model = SEMANTIC_MODEL_KEY in keys
    draft_names = {m["name"] for m in items["metrics"]}
    kept: dict[str, dict] = {}
    for m in items["metrics"]:  # inputs come before the metrics that use them
        if m["key"] not in keys:
            continue
        if not m["inputs"] and not keep_model:
            continue
        if all(i in kept or i not in draft_names for i in m["inputs"]):
            kept[m["name"]] = m
    return list(kept.values())


# ── appending to a top-level list ────────────────────────────────────────────


def _append_top_level(text: str, filename: str, key: str, entries: list[dict]) -> str:
    data = _parse(text, filename)
    lines = text.splitlines(keepends=True)
    offset = _seq_offset(text)
    if key not in data:
        lead = ["\n"] if text.strip() else ["version: 2\n", "\n"]
        return _splice(lines, len(lines), lead + [f"{key}:\n", *_sequence_lines(entries, offset, offset)], True, ()).text
    key_line, key_col = data.lc.key(key)
    existing = data[key]
    if existing is not None and not isinstance(existing, list):
        raise SchemaYamlError(f"`{key}` in {filename} is not a list")
    if existing:
        _require_block(lines, key_line, f"`{key}` in {filename}")
    names = {e.get("name") for e in existing or [] if isinstance(e, dict)}
    clash = [e["name"] for e in entries if e.get("name") in names]
    if clash:
        raise SchemaYamlError(f"{filename} already has `{clash[0]}` under {key}")
    dash = _dash_col(lines, existing, key_col + offset)
    new = _sequence_lines(entries, dash, offset)
    if existing and len(existing) > 1:
        second = existing.lc.item(1)[0]
        if second > 0 and not lines[second - 1].strip():
            new = ["\n", *new]  # keep the file's blank line between entries
    end = _key_bound(data, key, len(lines))
    return _splice(lines, _after_content(lines, key_line, end), new, True, ()).text


# ── adding keys inside an existing mapping (latest spec) ─────────────────────


def _model_entry(data: CommentedMap, model: str, filename: str) -> tuple[Any, int, int]:
    models = data.get("models")
    if not isinstance(models, list):
        raise SchemaYamlError(f"{filename} has no `models:` list")
    index = next((i for i, e in enumerate(models) if isinstance(e, dict) and e.get("name") == model), None)
    if index is None:
        raise SchemaYamlError(f"{filename} has no entry for `{model}`")
    start = models.lc.item(index)[0]
    end = models.lc.item(index + 1)[0] if index + 1 < len(models) else _key_bound(data, "models", 10**9)
    return models[index], start, end


def _add_keys(text: str, mapping: Any, start: int, end: int, additions: dict, label: str) -> str:
    """`additions` appended at the end of `mapping` (lines [start, end)), at its key indent."""
    clash = [k for k in additions if k in mapping]
    if clash:
        raise SchemaYamlError(f"{label} already has `{clash[0]}`")
    lines = text.splitlines(keepends=True)
    indent = mapping.lc.key(next(iter(mapping)))[1]
    new = _mapping_lines(additions, indent, _seq_offset(text))
    return _splice(lines, _after_content(lines, start, min(end, len(lines))), new, False, ()).text


def _add_column_keys(text: str, filename: str, model: str, column: str, additions: dict) -> str:
    data = _parse(text, filename)
    entry, _start, end = _model_entry(data, model, filename)
    columns = entry.get("columns")
    if not isinstance(columns, list):
        raise SchemaYamlError(f"`columns` for `{model}` in {filename} is not a list")
    _require_block(text.splitlines(keepends=True), entry.lc.key("columns")[0], f"`columns` for `{model}`")
    index = next((i for i, c in enumerate(columns) if isinstance(c, dict)
                  and str(c.get("name", "")).lower() == column.lower()), None)
    if index is None:
        raise SchemaYamlError(f"`{model}` in {filename} has no column `{column}`")
    col_start = columns.lc.item(index)[0]
    col_end = columns.lc.item(index + 1)[0] if index + 1 < len(columns) else _key_bound(entry, "columns", end)
    return _add_keys(text, columns[index], col_start, col_end, additions, f"column `{column}` of `{model}`")


# ── rendering ────────────────────────────────────────────────────────────────


def render_legacy(original: str | None, filename: str, items: dict, keys: Iterable[str]) -> str:
    keys = set(keys)
    text = original or ""
    models = [items["semantic_model"]] if SEMANTIC_MODEL_KEY in keys else []
    metrics = [m["entry"] for m in chosen_metrics(items, keys)]
    if models:
        text = _append_top_level(text, filename, "semantic_models", models)
    if metrics:
        text = _append_top_level(text, filename, "metrics", metrics)
    expected = _plain(_parse(original or "", filename)) if original else ({"version": 2} if models or metrics else {})
    for key, entries in (("semantic_models", models), ("metrics", metrics)):
        if entries:
            expected[key] = (expected.get(key) or []) + copy.deepcopy(entries)
    _verify(text, filename, expected)
    return text


def render_latest(original: str | None, filename: str, model: str, items: dict, keys: Iterable[str]) -> str:
    keys = set(keys)
    metrics = chosen_metrics(items, keys)
    sm = items["semantic_model"] if SEMANTIC_MODEL_KEY in keys else None
    columns = list(sm["columns"]) if sm else []
    text = node_text(original, filename, "models", model, columns) if sm else (original or "")
    expected = _plain(_parse(text, filename)) if text else {}
    if sm:
        for column, additions in sm["columns"].items():
            text = _add_column_keys(text, filename, model, column, additions)
        model_metrics = [m["entry"] for m in metrics if m["level"] == "model"]
        additions = {**sm["model"], **({"metrics": model_metrics} if model_metrics else {})}
        data = _parse(text, filename)
        entry, start, end = _model_entry(data, model, filename)
        text = _add_keys(text, entry, start, end, additions, f"`{model}` in {filename}")
        _expect_model(expected, model, sm["columns"], additions)
    top = [m["entry"] for m in metrics if m["level"] == "top"]
    if top:
        text = _append_top_level(text, filename, "metrics", top)
        expected["metrics"] = (expected.get("metrics") or []) + copy.deepcopy(top)
    _verify(text, filename, expected)
    return text


def _expect_model(expected: dict, model: str, columns: dict, additions: dict) -> None:
    entry = next(e for e in expected["models"] if isinstance(e, dict) and e.get("name") == model)
    for col in entry.get("columns") or []:
        if isinstance(col, dict) and str(col.get("name", "")).lower() in {c.lower() for c in columns}:
            match = next(v for k, v in columns.items() if k.lower() == str(col["name"]).lower())
            col.update(copy.deepcopy(match))
    entry.update(copy.deepcopy(additions))


def _verify(text: str, filename: str, expected: dict) -> None:
    try:
        actual = _plain(_parse(text, filename))
    except SchemaYamlError as exc:
        raise SchemaYamlError(f"could not safely edit {filename}: {exc}") from exc
    if actual != _plain(expected):
        raise SchemaYamlError(
            f"could not safely edit {filename} — its layout is unusual; add the semantic model by hand"
        )
