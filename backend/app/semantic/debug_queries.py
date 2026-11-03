"""Metric debugging (plan 15, Base): the warehouse checks for one metric query (pure; unit-tested).

From the worker's `explain_plan` result (inputs, models, joins in the plan, group-bys) build
one SELECT per check:

- input: per simple-metric input — rows, rows in the requested range (and the query's own
  filters when they only use the input's semantic model), rows kept by the metric's filter,
  nulls in the input's expression, and the agg time dimension's min/max;
- join: per entity join in the plan — left rows before/after the join, left rows without a
  match, and keys repeated on the right side (fan-out: the classic double count);
- dimension / variants: per categorical group-by — null and empty shares, and values that
  differ only by case or whitespace.

Expressions are the project's own (semantic model YAML) and are pasted verbatim, the way
MetricFlow does; relations are already rendered. Every SQL still goes through
query_spec.checked_sql() before it runs.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from app.ai.sql_guard import dialect_for

# Text casts per dialect: everything else takes `varchar`
_STRING_TYPES = {"bigquery": "string", "databricks": "string", "spark": "string"}
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$")
_TEMPLATE = re.compile(r"\{\{\s*(Dimension|TimeDimension|Entity)\(\s*(['\"])([A-Za-z0-9_]+)\2"
                       r"(?:\s*,\s*(['\"])([A-Za-z0-9_]+)\4)?\s*\)\s*\}\}")
MAX_VARIANTS = 10


@dataclass(frozen=True)
class CheckQuery:
    id: str
    kind: str  # input | join | dimension | variants
    node: str | None  # the plan step it belongs to
    sql: str
    meta: dict[str, Any] = field(default_factory=dict)


def string_type(adapter_type: str | None) -> str:
    return _STRING_TYPES.get(dialect_for(adapter_type) or "", "varchar")


def iso_or_none(value: Any) -> str | None:
    """A date/datetime literal safe to paste into SQL, or None."""
    text = str(value).strip() if value not in (None, "") else ""
    return text if _ISO.fullmatch(text) else None


def _entity(model: Mapping[str, Any], name: str) -> dict | None:
    return next((e for e in model.get("entities", []) if e["name"] == name), None)


def _dimension(model: Mapping[str, Any], name: str) -> dict | None:
    return next((d for d in model.get("dimensions", []) if d["name"] == name), None)


def resolve_filter(template: str, model: Mapping[str, Any]) -> str | None:
    """A MetricFlow filter as SQL on `model`'s own table, or None when it needs another model
    (a joined dimension), a time grain, or anything else MetricFlow would have to render."""
    unresolved = False

    def replace(match: re.Match) -> str:
        nonlocal unresolved
        kind, name, grain = match.group(1), match.group(3), match.group(5)
        *links, element = name.split("__")
        if kind == "Entity":
            found = _entity(model, element) if not links else None
        else:
            found = _dimension(model, element)
            if links and not _entity(model, links[-1]):
                found = None
            if kind == "TimeDimension" and grain and grain != "day":
                found = None
        if found is None:
            unresolved = True
            return match.group(0)
        return f"({found['expr']})"

    sql = _TEMPLATE.sub(replace, template)
    if unresolved or "{{" in sql or "{%" in sql:
        return None
    return sql


def _and(parts: list[str]) -> str:
    return " and ".join(f"({p})" for p in parts) if parts else "1 = 1"


def _time_expr(model: Mapping[str, Any], name: str | None) -> str | None:
    dim = _dimension(model, name) if name else None
    return dim["expr"] if dim else None


def _range_sql(time_expr: str | None, start: str | None, end: str | None) -> list[str]:
    if time_expr is None:
        return []
    parts = []
    if start:
        parts.append(f"cast({time_expr} as timestamp) >= cast('{start}' as timestamp)")
    if end:
        parts.append(f"cast({time_expr} as timestamp) <= cast('{end}' as timestamp)")
    return parts


def first_node(plan: list[dict], kind: str, model: str | None = None) -> str | None:
    for node in plan:
        if node.get("kind") == kind and (model is None or node.get("semantic_model") == model):
            return node["id"]
    return None


def _input_items(explained: Mapping[str, Any], query: Mapping[str, Any], notes: list[str]) -> dict[tuple, dict]:
    """Inputs grouped by (semantic model, scope, agg time expr): one check query reads each table once."""
    models = explained.get("models") or {}
    start, end = iso_or_none(query.get("start")), iso_or_none(query.get("end"))
    groups: dict[tuple, dict] = {}
    for item in explained.get("inputs") or []:
        model = models.get(item.get("semantic_model"))
        if not model or not model.get("relation"):
            continue
        time_expr = _time_expr(model, item.get("agg_time_dimension"))
        query_filters = [resolve_filter(w, model) for w in query.get("where") or []]
        applied = [f for f in query_filters if f is not None]
        if len(applied) < len(query_filters):
            notes.append(f"The query's filters that need a join aren't applied to {item['semantic_model']}'s row counts.")
        metric_filters = [resolve_filter(f, model) for f in item.get("filters") or []]
        resolved = None if any(f is None for f in metric_filters) else [f for f in metric_filters if f is not None]
        scope = _and(_range_sql(time_expr, start, end) + applied)
        group = groups.setdefault((item["semantic_model"], scope, time_expr), {
            "model": model, "scope": scope, "time_expr": time_expr, "items": [],
            "meta": {"semantic_model": item["semantic_model"], "agg_time_dimension": item.get("agg_time_dimension"),
                     "start": start, "end": end, "has_time": time_expr is not None},
        })
        entry = {"metric": item["metric"], "via": item.get("via"), "expr": item["expr"], "agg": item.get("agg"),
                 "filters": item.get("filters") or [], "filter_checked": resolved is not None,
                 "kept": _and(resolved or [])}
        if all((e["expr"], e["kept"]) != (entry["expr"], entry["kept"]) for e in group["items"]):
            group["items"].append(entry)
    return groups


def _input_checks(explained: Mapping[str, Any], query: Mapping[str, Any], notes: list[str]) -> list[CheckQuery]:
    """Per table read: its rows, rows in scope and the agg time span once; then each input's
    rows kept by its filter and nulls in its expression (columns kept_rows_<i>, null_rows_<i>)."""
    plan = explained.get("plan") or []
    out: list[CheckQuery] = []
    for group in _input_items(explained, query, notes).values():
        scope, time_expr = group["scope"], group["time_expr"]
        lines = ["count(*) as total_rows", f"sum(case when {scope} then 1 else 0 end) as scope_rows",
                 f"min({time_expr or 'null'}) as min_time", f"max({time_expr or 'null'}) as max_time"]
        for i, e in enumerate(group["items"]):
            lines.append(f"sum(case when {scope} and {e['kept']} then 1 else 0 end) as kept_rows_{i}")
            lines.append(f"sum(case when {scope} and {e['kept']} and ({e['expr']}) is null then 1 else 0 end)"
                         f" as null_rows_{i}")
        sql = "select\n  " + ",\n  ".join(lines) + f"\nfrom {group['model']['relation']} wickd_input"
        items = [{k: v for k, v in e.items() if k != "kept"} for e in group["items"]]
        out.append(CheckQuery(
            id=f"input:{len(out)}", kind="input", node=first_node(plan, "read", group["meta"]["semantic_model"]),
            sql=sql, meta={**group["meta"], "metrics": [e["metric"] for e in items], "items": items},
        ))
    return out


def _side(models: Mapping[str, Any], names: list[str], entity: str, *, unique: bool) -> str | None:
    """The model on one side of a join that defines `entity` (the unique side prefers primary keys)."""
    having = [n for n in names if n in models and _entity(models[n], entity)]
    if unique:
        having.sort(key=lambda n: _entity(models[n], entity)["type"] not in ("primary", "unique", "natural"))
    return having[0] if having else None


def _join_checks(explained: Mapping[str, Any], notes: list[str]) -> list[CheckQuery]:
    models, plan = explained.get("models") or {}, explained.get("plan") or []
    group_by = explained.get("group_by") or []
    out: list[CheckQuery] = []
    seen: set[tuple] = set()
    for node in plan:
        if node.get("kind") != "join":
            continue
        for target in node.get("targets") or []:
            entity = target.get("entity")
            left = _side(models, node.get("left_models") or [], entity, unique=False) if entity else None
            right = _side(models, target.get("semantic_models") or [], entity, unique=True) if entity else None
            if not left or not right or left == right:
                if entity:
                    notes.append(f"The join on `{entity}` wasn't checked: its models couldn't be resolved.")
                continue
            if (left, right, entity) in seen:
                continue
            seen.add((left, right, entity))
            lkey, rkey = _entity(models[left], entity)["expr"], _entity(models[right], entity)["expr"]
            sql = (
                f"with wickd_left as (select ({lkey}) as k from {models[left]['relation']} wickd_l),\n"
                f"wickd_right as (select ({rkey}) as k, count(*) as n from {models[right]['relation']} wickd_r"
                f" group by ({rkey}))\n"
                "select\n  count(*) as left_rows,\n  sum(coalesce(wickd_right.n, 1)) as joined_rows,\n"
                "  sum(case when wickd_right.k is null then 1 else 0 end) as unmatched_rows,\n"
                "  sum(case when wickd_left.k is null then 1 else 0 end) as null_keys,\n"
                "  (select count(*) from wickd_right where wickd_right.n > 1) as duplicate_keys\n"
                "from wickd_left left join wickd_right on wickd_left.k = wickd_right.k"
            )
            dims = [g["name"] for g in group_by if g.get("semantic_model") == right]
            out.append(CheckQuery(
                id=f"join:{len(out)}", kind="join", node=node["id"], sql=sql,
                meta={"left": left, "right": right, "entity": entity, "join_type": target.get("join_type"),
                      "dimensions": dims, "right_entity_type": _entity(models[right], entity)["type"]},
            ))
    return out


def _dimension_checks(explained: Mapping[str, Any], adapter_type: str | None) -> list[CheckQuery]:
    models, plan = explained.get("models") or {}, explained.get("plan") or []
    text = string_type(adapter_type)
    out: list[CheckQuery] = []
    for g in explained.get("group_by") or []:
        model = models.get(g.get("semantic_model"))
        if g.get("kind") != "dimension" or not model or not model.get("relation") or not g.get("expr"):
            continue
        dim = _dimension(model, g["element"])
        if dim is None or dim.get("type") != "categorical":
            continue
        e, rel = f"({g['expr']})", model["relation"]
        norm = f"lower(trim(cast({e} as {text})))"
        node = first_node(plan, "read", g["semantic_model"])
        meta = {"dimension": g["name"], "semantic_model": g["semantic_model"]}
        out.append(CheckQuery(id=f"dimension:{g['name']}", kind="dimension", node=node, meta=meta, sql=(
            "select\n  count(*) as total_rows,\n"
            f"  sum(case when {e} is null then 1 else 0 end) as null_rows,\n"
            f"  sum(case when {e} is not null and trim(cast({e} as {text})) = '' then 1 else 0 end) as empty_rows,\n"
            f"  count(distinct {e}) as distinct_values,\n  count(distinct {norm}) as distinct_normalized\n"
            f"from {rel} wickd_dim"
        )))
        out.append(CheckQuery(id=f"variants:{g['name']}", kind="variants", node=node, meta=meta, sql=(
            f"select\n  {norm} as normalized,\n  count(distinct {e}) as variants,\n"
            f"  min(cast({e} as {text})) as example_a,\n  max(cast({e} as {text})) as example_b,\n"
            f"  count(*) as row_count\nfrom {rel} wickd_dim\nwhere {e} is not null\n"
            f"group by {norm}\nhaving count(distinct {e}) > 1\norder by count(*) desc\nlimit {MAX_VARIANTS}"
        )))
    return out


def build_checks(
    explained: Mapping[str, Any], query: Mapping[str, Any], adapter_type: str | None
) -> tuple[list[CheckQuery], list[str]]:
    """(check queries, notes about what couldn't be checked) for an explain_plan result."""
    notes: list[str] = []
    checks = _input_checks(explained, query, notes) + _join_checks(explained, notes)
    checks += _dimension_checks(explained, adapter_type)
    return checks, list(dict.fromkeys(notes))
