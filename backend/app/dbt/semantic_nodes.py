"""Semantic layer entries in manifest.json → graph nodes.

`semantic_models`, `metrics` and `saved_queries` become nodes with resource_type
`semantic_model` / `metric` / `saved_query`. Each keeps a small `semantic` dict with
what the side pane and docs show. Field shapes differ between dbt 1.7 and 1.12 and
between the legacy and latest YAML spec (latest-spec simple metrics carry
`metric_aggregation_params` instead of a measure), so every read is defensive.
"""

import re
from typing import Any

SEMANTIC_SECTIONS = {
    "semantic_models": "semantic_model",
    "metrics": "metric",
    "saved_queries": "saved_query",
}
SEMANTIC_RESOURCE_TYPES = frozenset(SEMANTIC_SECTIONS.values())

_REF_NAME = re.compile(r"""ref\(\s*['"](?:[^'"]+['"]\s*,\s*['"])?([^'"]+)['"]""")


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _name(value: Any) -> str | None:
    """A `{name: …}` reference (or a bare string) → its name."""
    if isinstance(value, str):
        return value or None
    name = _dict(value).get("name")
    return name if isinstance(name, str) and name else None


def where_text(value: Any) -> str | None:
    """`{where_filters: [{where_sql_template}]}` (or a list of them) → one string."""
    if isinstance(value, str):
        return value or None
    filters = _list(_dict(value).get("where_filters")) if isinstance(value, dict) else _list(value)
    parts = [t for f in filters if isinstance(t := _dict(f).get("where_sql_template"), str) and t]
    return " AND ".join(parts) or None


def _model_name(raw: dict[str, Any]) -> str | None:
    model = raw.get("model")
    if isinstance(model, str) and (m := _REF_NAME.search(model)):
        return m.group(1)
    deps = _list(_dict(raw.get("depends_on")).get("nodes"))
    return deps[0].split(".")[-1] if deps and isinstance(deps[0], str) else None


def semantic_model_info(raw: dict[str, Any]) -> dict[str, Any]:
    relation = _dict(raw.get("node_relation"))
    return {
        "model": _model_name(raw),
        "relation_name": relation.get("relation_name"),
        "agg_time_dimension": _dict(raw.get("defaults")).get("agg_time_dimension"),
        "primary_entity": raw.get("primary_entity"),
        "entities": [
            {"name": e.get("name"), "type": e.get("type"), "expr": e.get("expr"), "description": e.get("description") or ""}
            for e in map(_dict, _list(raw.get("entities"))) if e.get("name")
        ],
        "dimensions": [
            {
                "name": d.get("name"),
                "type": d.get("type"),
                "expr": d.get("expr"),
                "time_granularity": _dict(d.get("type_params")).get("time_granularity"),
                "description": d.get("description") or "",
            }
            for d in map(_dict, _list(raw.get("dimensions"))) if d.get("name")
        ],
        "measures": [
            {"name": m.get("name"), "agg": m.get("agg"), "expr": m.get("expr"), "description": m.get("description") or ""}
            for m in map(_dict, _list(raw.get("measures"))) if m.get("name")
        ],
    }


def _input_metrics(params: dict[str, Any]) -> list[str]:
    names = [_name(m) for m in _list(params.get("metrics"))]
    names += [_name(params.get("numerator")), _name(params.get("denominator"))]
    names.append(_name(_dict(params.get("cumulative_type_params")).get("metric")))
    seen: list[str] = []
    for n in names:
        if n and n not in seen:
            seen.append(n)
    return seen


def metric_info(raw: dict[str, Any]) -> dict[str, Any]:
    params = _dict(raw.get("type_params"))
    agg_params = _dict(params.get("metric_aggregation_params"))
    measure = _dict(params.get("measure"))
    cumulative = _dict(params.get("cumulative_type_params"))
    return {
        "type": raw.get("type"),
        "filter": where_text(raw.get("filter")),
        "measure": _name(measure),
        "agg": agg_params.get("agg"),
        "expr": params.get("expr"),
        "semantic_model": agg_params.get("semantic_model"),
        "numerator": _name(params.get("numerator")),
        "denominator": _name(params.get("denominator")),
        "input_metrics": _input_metrics(params),
        "window": _window(cumulative.get("window") or params.get("window")),
        "grain_to_date": cumulative.get("grain_to_date") or params.get("grain_to_date"),
        "time_granularity": raw.get("time_granularity"),
    }


def _window(value: Any) -> str | None:
    if isinstance(value, str):
        return value or None
    w = _dict(value)
    if w.get("count") and w.get("granularity"):
        return f"{w['count']} {w['granularity']}"
    return None


def saved_query_info(raw: dict[str, Any]) -> dict[str, Any]:
    params = _dict(raw.get("query_params"))
    return {
        "metrics": [m for m in _list(params.get("metrics")) if isinstance(m, str)],
        "group_by": [g for g in _list(params.get("group_by")) if isinstance(g, str)],
        "where": where_text(params.get("where")),
        "exports": [n for e in _list(raw.get("exports")) if (n := _name(e))],
    }


_INFO = {
    "semantic_model": semantic_model_info,
    "metric": metric_info,
    "saved_query": saved_query_info,
}


def semantic_info(resource_type: str, raw: dict[str, Any]) -> dict[str, Any]:
    return _INFO[resource_type](raw)
