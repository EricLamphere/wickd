"""MetricFlow worker: semantic_manifest.json + dialect → SQL. Never connects to a warehouse.

STANDALONE: run by the MetricFlow sidecar venv's Python (see sidecar_env.py), not by
the backend, so it must not import anything from `app`. Shipped next to the backend
as a PyInstaller data file.

Protocol: one JSON object per line on stdin, one reply per line on stdout.
  request  {"id": "...", "op": "...", "manifest_path": "...", "dialect": "duckdb", ...}
  reply    {"id": "...", "ok": true, "result": {...}}
         | {"id": "...", "ok": false, "error": {"code": "...", "message": "..."}}

Ops: ping, load, catalog, explain, explain_plan, dimension_values, validate, validate_draft. MetricFlow prints
warnings with print(), so stdout is reserved for replies and sys.stdout points at
stderr while requests run.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import traceback
from importlib import metadata
from pathlib import Path
from typing import Any

_REPLY_STREAM = sys.stdout
sys.stdout = sys.stderr

from metricflow.engine.metricflow_engine import MetricFlowEngine, MetricFlowQueryRequest
from metricflow.protocols.sql_client import SqlEngine
from metricflow_semantics.model.dbt_manifest_parser import (
    parse_manifest_from_dbt_generated_manifest,
)
from metricflow_semantics.model.semantic_manifest_lookup import SemanticManifestLookup

# adapter_type → (SqlEngine name, renderer module, renderer class, sqlglot dialect)
_DIALECTS: dict[str, tuple[str, str, str, str]] = {
    "duckdb": ("DUCKDB", "duckdb_renderer", "DuckDbSqlPlanRenderer", "duckdb"),
    "postgres": ("POSTGRES", "postgres", "PostgresSQLSqlPlanRenderer", "postgres"),
    "snowflake": ("SNOWFLAKE", "snowflake", "SnowflakeSqlPlanRenderer", "snowflake"),
    "bigquery": ("BIGQUERY", "big_query", "BigQuerySqlPlanRenderer", "bigquery"),
    "databricks": ("DATABRICKS", "databricks", "DatabricksSqlPlanRenderer", "databricks"),
    "spark": ("DATABRICKS", "databricks", "DatabricksSqlPlanRenderer", "databricks"),
    "redshift": ("REDSHIFT", "redshift", "RedshiftSqlPlanRenderer", "redshift"),
    "trino": ("TRINO", "trino", "TrinoSqlPlanRenderer", "trino"),
    "athena": ("ATHENA", "athena", "AthenaSqlPlanRenderer", "athena"),
}
# For ops that never render SQL (catalog, validate) any renderer will do.
_NEUTRAL_DIALECT = "duckdb"
_MAX_CACHED = 8


class WorkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RenderOnlyClient:
    """Satisfies MetricFlow's SqlClient protocol for explain; refuses to execute."""

    def __init__(self, dialect: str) -> None:
        engine_name, module, cls, _ = _DIALECTS[dialect]
        renderer_module = __import__(f"metricflow.sql.render.{module}", fromlist=[cls])
        self._engine = getattr(SqlEngine, engine_name)
        self._renderer = getattr(renderer_module, cls)()

    @property
    def sql_engine_type(self) -> SqlEngine:
        return self._engine

    @property
    def sql_plan_renderer(self) -> Any:
        return self._renderer

    def query(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("render-only client: execution goes through dbt show")

    execute = dry_run = query

    def close(self) -> None:
        pass

    def render_bind_parameter_key(self, key: str) -> str:
        return key


_manifests: dict[tuple[str, int, int], Any] = {}
_engines: dict[tuple[str, int, int, str], MetricFlowEngine] = {}


def _bounded_put(cache: dict, key: Any, value: Any) -> None:
    if len(cache) >= _MAX_CACHED:
        cache.pop(next(iter(cache)))
    cache[key] = value


def _manifest(path_str: str) -> tuple[Any, tuple[str, int, int]]:
    path = Path(path_str)
    try:
        stat = path.stat()
    except OSError:
        raise WorkerError("manifest_not_found", f"{path} doesn't exist yet — run dbt parse.") from None
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    if key not in _manifests:
        try:
            parsed = parse_manifest_from_dbt_generated_manifest(manifest_json_string=path.read_text())
        except Exception as exc:  # MetricFlow raises pydantic / parsing errors of many kinds
            raise WorkerError("manifest_invalid", f"MetricFlow couldn't read {path.name}: {exc}") from exc
        _bounded_put(_manifests, key, parsed)
    return _manifests[key], key


def _engine(req: dict[str, Any], *, needs_sql: bool) -> MetricFlowEngine:
    dialect = str(req.get("dialect") or "").lower()
    if dialect not in _DIALECTS:
        if needs_sql:
            raise WorkerError("unsupported_adapter", f"MetricFlow can't render SQL for the {dialect or 'unknown'} adapter.")
        dialect = _NEUTRAL_DIALECT
    manifest, key = _manifest(_require_str(req, "manifest_path"))
    engine_key = (*key, dialect)
    if engine_key not in _engines:
        try:
            engine = MetricFlowEngine(
                semantic_manifest_lookup=SemanticManifestLookup(manifest),
                sql_client=RenderOnlyClient(dialect),
            )
        except Exception as exc:
            raise WorkerError("manifest_invalid", f"MetricFlow couldn't load the semantic manifest: {exc}") from exc
        _bounded_put(_engines, engine_key, engine)
    return _engines[engine_key]


def _require_str(req: dict[str, Any], key: str) -> str:
    value = req.get(key)
    if not isinstance(value, str) or not value:
        raise WorkerError("bad_request", f"`{key}` is required")
    return value


def _str_list(req: dict[str, Any], key: str) -> list[str] | None:
    value = req.get(key)
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise WorkerError("bad_request", f"`{key}` must be a list of strings")
    return value


def _datetime(req: dict[str, Any], key: str) -> dt.datetime | None:
    value = req.get(key)
    if value in (None, ""):
        return None
    try:
        return dt.datetime.fromisoformat(str(value))
    except ValueError:
        raise WorkerError("bad_request", f"`{key}` must be an ISO date or datetime") from None


def _enum_value(value: Any) -> Any:
    return getattr(value, "value", value)


def _columns(sql: str, dialect: str) -> list[str]:
    """The query's output column names, read from its outermost SELECT."""
    try:
        import sqlglot

        read = _DIALECTS.get(dialect, _DIALECTS[_NEUTRAL_DIALECT])[3]
        return list(sqlglot.parse_one(sql, read=read).named_selects)
    except Exception:  # noqa: BLE001 — column names are a nicety; the SQL is what matters
        return []


def _explained(result: Any, dialect: str) -> dict[str, Any]:
    sql = result.sql_statement.sql
    return {"sql": sql, "columns": _columns(sql, dialect)}


def _invalid_query(exc: Exception) -> WorkerError:
    return WorkerError("invalid_query", str(exc).strip())


def op_ping(req: dict[str, Any]) -> dict[str, Any]:
    return {"engine_version": metadata.version("metricflow"), "python": sys.version.split()[0]}


def op_load(req: dict[str, Any]) -> dict[str, Any]:
    engine = _engine(req, needs_sql=False)
    return {"metrics": len(engine.list_metrics(include_dimensions=False)), "saved_queries": len(engine.list_saved_queries())}


def _dimension(d: Any) -> dict[str, Any]:
    params = getattr(d, "type_params", None)
    grain = getattr(params, "time_granularity", None) if params else None
    return {
        "name": d.dunder_name,
        "type": _enum_value(d.type),
        "time_granularity": _enum_value(grain) if grain else None,
        "label": getattr(d, "label", None),
        "description": getattr(d, "description", None),
    }


def op_catalog(req: dict[str, Any]) -> dict[str, Any]:
    engine = _engine(req, needs_sql=False)
    metrics = []
    for m in engine.list_metrics():
        metrics.append({
            "name": m.name,
            "label": getattr(m, "label", None),
            "description": m.description,
            "type": _enum_value(m.type),
            "dimensions": [_dimension(d) for d in (m.dimensions or [])],
            "semantic_models": [getattr(r, "semantic_model_name", str(r)) for r in (getattr(m, "semantic_models", None) or [])],
        })
    saved = []
    for q in engine.list_saved_queries():
        params = q.query_params
        saved.append({
            "name": q.name,
            "label": getattr(q, "label", None),
            "description": q.description,
            "metrics": list(params.metrics or []),
            "group_by": list(params.group_by or []),
            "where": list(params.where or []) if isinstance(params.where, list) else ([params.where] if params.where else []),
        })
    return {"metrics": metrics, "saved_queries": saved}


def op_explain(req: dict[str, Any]) -> dict[str, Any]:
    engine = _engine(req, needs_sql=True)
    saved_query = req.get("saved_query")
    metrics = _str_list(req, "metrics")
    if not saved_query and not metrics:
        raise WorkerError("bad_request", "pick at least one metric or a saved query")
    limit = req.get("limit")
    if limit is not None and (not isinstance(limit, int) or limit < 0):
        raise WorkerError("bad_request", "`limit` must be a non-negative integer")
    try:
        request = MetricFlowQueryRequest.create(
            saved_query_name=saved_query or None,
            metric_names=metrics,
            group_by_names=_str_list(req, "group_by"),
            where_constraints=_str_list(req, "where"),
            order_by_names=_str_list(req, "order_by"),
            limit=limit,
            time_constraint_start=_datetime(req, "start"),
            time_constraint_end=_datetime(req, "end"),
        )
        result = engine.explain(request)
    except WorkerError:
        raise
    except Exception as exc:
        raise _invalid_query(exc) from exc
    return _explained(result, req["dialect"])


def op_dimension_values(req: dict[str, Any]) -> dict[str, Any]:
    engine = _engine(req, needs_sql=True)
    try:
        result = engine.explain_get_dimension_values(
            metric_names=_str_list(req, "metrics") or [],
            get_group_by_values=_require_str(req, "dimension"),
        )
    except WorkerError:
        raise
    except Exception as exc:
        raise _invalid_query(exc) from exc
    return _explained(result, req["dialect"])


def _issue(issue: Any) -> dict[str, Any]:
    ctx = getattr(issue, "context", None)
    element = getattr(ctx, "semantic_model_element", None) if ctx else None
    semantic_model = getattr(ctx, "semantic_model", None) if ctx else None
    metric = getattr(ctx, "metric", None) if ctx else None
    saved_query = getattr(ctx, "saved_query", None) if ctx else None
    if metric is not None:
        object_type, object_name = "metric", getattr(metric, "metric_name", None)
    elif saved_query is not None:
        object_type, object_name = "saved_query", getattr(saved_query, "saved_query_name", None)
    elif element is not None:
        object_type, object_name = "semantic_model", getattr(element, "semantic_model_name", None)
    elif semantic_model is not None:
        object_type, object_name = "semantic_model", getattr(semantic_model, "semantic_model_name", None)
    else:
        object_type, object_name = None, None
    element_type = getattr(ctx, "element_type", None) if ctx else None
    return {
        "level": str(getattr(getattr(issue, "level", None), "name", "error")).lower(),
        "message": str(issue.message),
        "object_type": object_type,
        "object_name": object_name,
        "element_type": str(_enum_value(element_type)) if element_type else None,
        "element_name": getattr(element, "element_name", None) if element else None,
    }


def op_validate(req: dict[str, Any]) -> dict[str, Any]:
    from metricflow_semantic_interfaces.validations.semantic_manifest_validator import (
        SemanticManifestValidator,
    )

    manifest, _ = _manifest(_require_str(req, "manifest_path"))
    try:
        results = SemanticManifestValidator().validate_semantic_manifest(manifest)
    except Exception as exc:
        raise WorkerError("manifest_invalid", f"Validation failed to run: {exc}") from exc
    return {
        "errors": [_issue(i) for i in results.errors],
        "warnings": [_issue(i) for i in results.warnings],
        "future_errors": [_issue(i) for i in results.future_errors],
    }


def _merged(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    """`base` (semantic_manifest.json) with the draft's objects added (same names replaced)."""
    merged = dict(base)
    for key in ("semantic_models", "metrics"):
        new = [x for x in extra.get(key) or [] if isinstance(x, dict)]
        names = {x.get("name") for x in new}
        merged[key] = [x for x in base.get(key) or [] if x.get("name") not in names] + new
    spines = extra.get("time_spines") or []
    config = dict(base.get("project_configuration") or {})
    if spines and not config.get("time_spines") and not config.get("time_spine_table_configurations"):
        merged["project_configuration"] = {**config, "time_spines": spines}
    return merged


def _new_issues(issues: Any, known: set[str]) -> list[dict[str, Any]]:
    return [_issue(i) for i in issues if str(i.message) not in known]


def op_validate_draft(req: dict[str, Any]) -> dict[str, Any]:
    """A draft (semantic models / metrics in manifest JSON) checked against the project's
    semantic manifest without writing anything: MetricFlow's validations (only issues the
    draft adds), then the SQL of a LIMIT smoke query per metric in `smoke`.

    request: extra {semantic_models, metrics, time_spines?}, smoke [metric], smoke_group_by [name]
    result:  {errors, warnings, smoke: {metric: {sql} | {error}}}
    """
    from metricflow_semantic_interfaces.validations.semantic_manifest_validator import (
        SemanticManifestValidator,
    )

    path = Path(_require_str(req, "manifest_path"))
    base_manifest, _ = _manifest(str(path))
    extra = req.get("extra")
    if not isinstance(extra, dict):
        raise WorkerError("bad_request", "`extra` must be an object")
    validator = SemanticManifestValidator()
    try:
        base_results = validator.validate_semantic_manifest(base_manifest)
        merged = _merged(json.loads(path.read_text()), extra)
        manifest = parse_manifest_from_dbt_generated_manifest(manifest_json_string=json.dumps(merged))
        results = validator.validate_semantic_manifest(manifest)
    except Exception as exc:  # noqa: BLE001 — the draft doesn't even load: report it
        message = f"MetricFlow couldn't read the draft: {exc}".strip()
        return {"errors": [{"level": "error", "message": message[:2000], "object_type": None, "object_name": None,
                            "element_type": None, "element_name": None}], "warnings": [], "smoke": {}}
    errors = _new_issues(results.errors, {str(i.message) for i in base_results.errors})
    warnings = _new_issues(results.warnings, {str(i.message) for i in base_results.warnings})
    if errors:
        return {"errors": errors, "warnings": warnings, "smoke": {}}
    smoke: dict[str, dict[str, str]] = {}
    dialect = str(req.get("dialect") or "").lower()
    metrics = _str_list(req, "smoke") or []
    if metrics and dialect in _DIALECTS:
        try:
            engine = MetricFlowEngine(semantic_manifest_lookup=SemanticManifestLookup(manifest),
                                      sql_client=RenderOnlyClient(dialect))
        except Exception as exc:  # noqa: BLE001 — reported per metric, validation still stands
            return {"errors": [], "warnings": warnings, "smoke": {m: {"error": str(exc)} for m in metrics}}
        group_by = _str_list(req, "smoke_group_by") or []
        for metric in metrics:
            try:
                result = engine.explain(MetricFlowQueryRequest.create(
                    metric_names=[metric], group_by_names=group_by,
                    order_by_names=[f"-{g}" for g in group_by[:1]], limit=5,
                ))
                smoke[metric] = {"sql": result.sql_statement.sql}
            except Exception as exc:  # noqa: BLE001 — MetricFlow raises many kinds; reported per metric
                smoke[metric] = {"error": str(exc).strip()[:1500]}
    return {"errors": [], "warnings": warnings, "smoke": smoke}


# ── explain_plan (metric debugging, plan 15) ──────────────────────────────────
# MetricFlow's dataflow plan, flattened for the Debug panel, plus what the backend needs to
# build its check queries: the simple-metric inputs, the semantic models they read, the
# joins and the group-bys, each resolved to source expressions. Defensive throughout: an
# attribute a MetricFlow version doesn't have leaves its field out (the plan still shows).

# Plan nodes that only reshape columns: folded into their parents so the pipeline reads
# as read → join → filter → aggregate → compute.
_PASSTHROUGH_NODES = {
    "SelectorNode", "AliasSpecsNode", "WriteToResultDataTableNode", "WriteToResultTableNode",
    "AddGeneratedUuidColumnNode",
}
_NODE_KINDS = {
    "ReadSqlSourceNode": "read",
    "MetricTimeDimensionTransformNode": "metric_time",
    "JoinOnEntitiesNode": "join",
    "WhereFilterNode": "filter",
    "ConstrainTimeRangeNode": "constrain_time",
    "AggregateSimpleMetricInputsNode": "aggregate",
    "AggregateMeasuresNode": "aggregate",
    "ComputeMetricsNode": "compute",
    "CombineAggregatedOutputsNode": "combine",
    "JoinOverTimeRangeNode": "join_over_time",
    "JoinToTimeSpineNode": "join_time_spine",
    "JoinConversionEventsNode": "join_conversion",
    "SemiAdditiveJoinNode": "semi_additive",
    "OrderByLimitNode": "order_limit",
    "MinMaxNode": "min_max",
    "WindowReaggregationNode": "window",
    "JoinToCustomGranularityNode": "custom_granularity",
}
_MAX_PLAN_NODES = 400


def _name_of(ref: Any) -> str | None:
    for attr in ("element_name", "semantic_model_name", "name"):
        value = getattr(ref, attr, None)
        if isinstance(value, str):
            return value
    return None


def _read_models(node: Any, seen: set[int] | None = None) -> list[str]:
    """Semantic models read anywhere under `node`, in plan order."""
    seen = set() if seen is None else seen
    if id(node) in seen:
        return []
    seen.add(id(node))
    if type(node).__name__ == "ReadSqlSourceNode":
        name = _name_of(getattr(getattr(node, "data_set", None), "semantic_model_reference", None))
        return [name] if name else []
    found: list[str] = []
    for parent in getattr(node, "parent_nodes", ()) or ():
        found.extend(m for m in _read_models(parent, seen) if m not in found)
    return found


def _join_type(value: Any) -> str | None:
    """SqlJoinType ('LEFT OUTER JOIN') → 'left_outer'."""
    if value is None:
        return None
    text = str(_enum_value(value)).lower().replace(" join", "").strip()
    return text.replace(" ", "_") or None


def _time_range(constraint: Any) -> dict[str, str] | None:
    if constraint is None:
        return None
    start = getattr(constraint, "start_time", None)
    end = getattr(constraint, "end_time", None)
    return {"start": str(start) if start else None, "end": str(end) if end else None}


def _node_details(node: Any) -> dict[str, Any]:
    cls = type(node).__name__
    if cls == "ReadSqlSourceNode":
        return {"semantic_model": _name_of(getattr(getattr(node, "data_set", None), "semantic_model_reference", None))}
    if cls == "MetricTimeDimensionTransformNode":
        return {"agg_time_dimension": _name_of(getattr(node, "aggregation_time_dimension_reference", None))}
    if cls == "JoinOnEntitiesNode":
        left = getattr(node, "left_node", None)
        targets = []
        for t in getattr(node, "join_targets", ()) or ():
            targets.append({
                "entity": _name_of(getattr(t, "join_on_entity", None)),
                "join_type": _join_type(getattr(t, "join_type", None)),
                "semantic_models": _read_models(getattr(t, "join_node", None)) if getattr(t, "join_node", None) else [],
            })
        return {"left_models": _read_models(left) if left is not None else [], "targets": targets}
    if cls == "WhereFilterNode":
        return {"filters": [str(getattr(s, "where_sql", "")) for s in getattr(node, "filter_specs", ()) or ()]}
    if cls in ("ConstrainTimeRangeNode", "JoinOverTimeRangeNode"):
        details: dict[str, Any] = {"time_range": _time_range(getattr(node, "time_range_constraint", None))}
        if cls == "JoinOverTimeRangeNode":
            window = getattr(node, "window", None)
            details["window"] = f"{window.count} {_enum_value(window.granularity)}" if window is not None else None
            grain = getattr(node, "grain_to_date", None)
            details["grain_to_date"] = str(_enum_value(grain)) if grain else None
        return details
    if cls == "AggregateSimpleMetricInputsNode":
        mapping = getattr(node, "null_fill_value_mapping", None)
        items = getattr(mapping, "_element_name_and_null_fill_value_items", None) or ()
        return {"metrics": [str(name) for name, _ in items]}
    if cls == "ComputeMetricsNode":
        specs = getattr(node, "computed_metric_specs", None) or getattr(node, "metric_specs", None) or ()
        return {"metrics": [s.element_name for s in specs]}
    if cls in ("JoinToTimeSpineNode", "CombineAggregatedOutputsNode"):
        join_type = getattr(node, "join_type", None)
        return {"join_type": _join_type(join_type) or ("full_outer" if cls == "CombineAggregatedOutputsNode" else None)}
    if cls == "OrderByLimitNode":
        return {"limit": getattr(node, "limit", None)}
    return {}


def _plan_nodes(sinks: Any) -> list[dict[str, Any]]:
    """The plan as a flat list, sources first; `inputs` are the ids of the nodes feeding each one."""
    out: list[dict[str, Any]] = []
    ids: dict[int, list[str]] = {}

    def visit(node: Any) -> list[str]:
        key = id(node)
        if key in ids:
            return ids[key]
        ids[key] = []  # a cycle can't happen in a DAG, but never recurse forever
        inputs: list[str] = []
        for parent in getattr(node, "parent_nodes", ()) or ():
            inputs.extend(i for i in visit(parent) if i not in inputs)
        cls = type(node).__name__
        if cls in _PASSTHROUGH_NODES or len(out) >= _MAX_PLAN_NODES:
            ids[key] = inputs
            return inputs
        node_id = str(getattr(getattr(node, "node_id", None), "id_str", None) or f"n{len(out)}")
        try:
            details = _node_details(node)
        except Exception:  # noqa: BLE001 — one odd node shouldn't lose the plan
            details = {}
        out.append({"id": node_id, "kind": _NODE_KINDS.get(cls, "other"), "node_type": cls,
                    "label": str(getattr(node, "description", cls)), "inputs": inputs, **details})
        ids[key] = [node_id]
        return [node_id]

    for sink in sinks:
        visit(sink)
    return out


def _by_name(items: Any) -> dict[str, Any]:
    return {getattr(x, "name", None): x for x in items or []}


def _filters(where: Any) -> list[str]:
    return [str(f.where_sql_template) for f in getattr(where, "where_filters", None) or []]


class _InputCollector:
    """The simple-metric inputs feeding a set of metrics, with the filters that apply to each."""

    def __init__(self, manifest: Any) -> None:
        self.metrics = _by_name(manifest.metrics)
        self.models = _by_name(manifest.semantic_models)
        self.inputs: list[dict[str, Any]] = []
        # every metric reached: its type, expression and inputs (Reconcile drafts SQL from these)
        self.defs: dict[str, dict[str, Any]] = {}

    def _define(self, name: str, metric: Any) -> None:
        params = metric.type_params
        kind = str(_enum_value(metric.type))
        entry: dict[str, Any] = {"type": kind, "expr": getattr(params, "expr", None) if kind == "derived" else None,
                                 "filters": _filters(getattr(metric, "filter", None)), "inputs": []}
        for role, child in [("numerator", getattr(params, "numerator", None)),
                            ("denominator", getattr(params, "denominator", None)),
                            *[("input", c) for c in getattr(params, "metrics", None) or []]]:
            if child is None:
                continue
            entry["inputs"].append({
                "role": role, "name": child.name, "alias": getattr(child, "alias", None),
                "filters": _filters(getattr(child, "filter", None)),
                "offset": bool(getattr(child, "offset_window", None) or getattr(child, "offset_to_grain", None)),
            })
        self.defs[name] = entry

    def collect(self, name: str, filters: list[str], via: str, depth: int = 0) -> None:
        metric = self.metrics.get(name)
        if metric is None or depth > 20:
            self._from_measure(name, filters, via)
            return
        own = filters + _filters(getattr(metric, "filter", None))
        params = metric.type_params
        if name not in self.defs:
            try:
                self._define(name, metric)
            except Exception as exc:  # noqa: BLE001 — a definition we can't describe only loses the reconcile draft
                print(f"metric definition {name}: {exc}", file=sys.stderr)
        if str(_enum_value(metric.type)) == "simple":
            agg = getattr(params, "metric_aggregation_params", None)
            if agg is None and getattr(params, "measure", None) is not None:
                self._from_measure(params.measure.name, own + _filters(params.measure.filter), via)
                return
            self._add(name, via, getattr(agg, "semantic_model", None), getattr(params, "expr", None) or name,
                      getattr(agg, "agg", None), getattr(agg, "agg_time_dimension", None), own)
            return
        for child in self._children(params):
            self.collect(child.name, own + _filters(getattr(child, "filter", None)), via, depth + 1)

    @staticmethod
    def _children(params: Any) -> list[Any]:
        children = [c for c in (getattr(params, "numerator", None), getattr(params, "denominator", None)) if c]
        children += list(getattr(params, "metrics", None) or [])
        cumulative = getattr(params, "cumulative_type_params", None)
        if cumulative is not None and getattr(cumulative, "metric", None) is not None:
            children.append(cumulative.metric)
        elif getattr(params, "measure", None) is not None:
            children.append(params.measure)
        conversion = getattr(params, "conversion_type_params", None)
        for attr in ("base_metric", "conversion_metric", "base_measure", "conversion_measure"):
            value = getattr(conversion, attr, None) if conversion is not None else None
            if value is not None:
                children.append(value)
        return children

    def _from_measure(self, measure: str, filters: list[str], via: str) -> None:
        for model in self.models.values():
            for m in getattr(model, "measures", None) or []:
                if m.name == measure:
                    self._add(measure, via, model.name, m.expr or m.name, m.agg, m.agg_time_dimension, filters)
                    return

    def _add(self, name: str, via: str, model_name: str | None, expr: str, agg: Any, agg_time: str | None,
             filters: list[str]) -> None:
        model = self.models.get(model_name)
        defaults = getattr(model, "defaults", None) if model is not None else None
        agg_time = agg_time or getattr(defaults, "agg_time_dimension", None)
        entry = {"metric": name, "via": via, "semantic_model": model_name, "expr": str(expr),
                 "agg": str(_enum_value(agg)) if agg is not None else None, "agg_time_dimension": agg_time,
                 "filters": filters}
        if entry not in self.inputs:
            self.inputs.append(entry)


def _model_info(model: Any) -> dict[str, Any]:
    relation = getattr(model, "node_relation", None)
    return {
        "relation": getattr(relation, "relation_name", None),
        "entities": [{"name": e.name, "type": str(_enum_value(e.type)), "expr": e.expr or e.name}
                     for e in getattr(model, "entities", None) or []],
        "dimensions": [{"name": d.name, "type": str(_enum_value(d.type)), "expr": d.expr or d.name}
                       for d in getattr(model, "dimensions", None) or []],
    }


def _group_bys(query_spec: Any, models: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for kind, specs in (("dimension", getattr(query_spec, "dimension_specs", ())),
                        ("time_dimension", getattr(query_spec, "time_dimension_specs", ())),
                        ("entity", getattr(query_spec, "entity_specs", ()))):
        for spec in specs or ():
            links = [_name_of(e) for e in getattr(spec, "entity_links", ()) or ()]
            grain = getattr(getattr(spec, "time_granularity", None), "name", None)
            name = "__".join([*links, spec.element_name, *([str(grain)] if grain else [])])
            entry: dict[str, Any] = {"name": name, "kind": kind, "element": spec.element_name, "entity_links": links}
            if kind == "time_dimension" and not links and spec.element_name == "metric_time":
                entry["kind"] = "metric_time"
            elif kind != "entity":
                entry.update(_locate_dimension(spec.element_name, links, models))
            out.append(entry)
    return out


def _locate_dimension(element: str, links: list[str], models: dict[str, Any]) -> dict[str, Any]:
    """The semantic model a linked dimension lives in: the one with it and the last link entity."""
    candidates = [m for m in models.values() if any(d.name == element for d in getattr(m, "dimensions", None) or [])]
    if links:
        linked = [m for m in candidates if any(e.name == links[-1] for e in getattr(m, "entities", None) or [])]
        candidates = linked or candidates
    if not candidates:
        return {}
    model = candidates[0]
    dim = next(d for d in model.dimensions if d.name == element)
    return {"semantic_model": model.name, "expr": dim.expr or dim.name}


def op_explain_plan(req: dict[str, Any]) -> dict[str, Any]:
    """op_explain's request → {sql, columns, plan: [node], inputs, models, group_by, time_range}.

    A plan MetricFlow can't describe still returns the SQL with `plan_error` (the UI falls
    back to the SQL's CTE names)."""
    engine = _engine(req, needs_sql=True)
    metrics = _str_list(req, "metrics")
    if not metrics:
        raise WorkerError("bad_request", "debugging needs at least one metric")
    try:
        request = MetricFlowQueryRequest.create(
            metric_names=metrics,
            group_by_names=_str_list(req, "group_by"),
            where_constraints=_str_list(req, "where"),
            order_by_names=_str_list(req, "order_by"),
            limit=req.get("limit") if isinstance(req.get("limit"), int) else None,
            time_constraint_start=_datetime(req, "start"),
            time_constraint_end=_datetime(req, "end"),
        )
        result = engine.explain(request)
    except WorkerError:
        raise
    except Exception as exc:
        raise _invalid_query(exc) from exc
    out: dict[str, Any] = _explained(result, req["dialect"])
    manifest, _ = _manifest(_require_str(req, "manifest_path"))
    try:
        out["plan"] = _plan_nodes(result.dataflow_plan.sink_nodes)
    except Exception as exc:  # noqa: BLE001 — MetricFlow internals move between versions
        out["plan"], out["plan_error"] = [], f"{type(exc).__name__}: {exc}"[:500]
    try:
        collector = _InputCollector(manifest)
        for metric in metrics:
            collector.collect(metric, [], metric)
        models = _by_name(manifest.semantic_models)
        used = {i["semantic_model"] for i in collector.inputs}
        for node in out["plan"]:
            used.update(m for m in [node.get("semantic_model"), *node.get("left_models", [])] if m)
            for t in node.get("targets", []):
                used.update(t.get("semantic_models", []))
        group_by = _group_bys(result.query_spec, models)
        used.update(g["semantic_model"] for g in group_by if g.get("semantic_model"))
        out["inputs"] = collector.inputs
        out["metric_defs"] = collector.defs
        out["group_by"] = group_by
        out["models"] = {name: _model_info(models[name]) for name in sorted(n for n in used if n in models)}
        out["time_range"] = _time_range(getattr(result.query_spec, "time_range_constraint", None))
    except Exception as exc:  # noqa: BLE001 — the checks are skipped, the plan still shows
        out.update(inputs=[], group_by=[], models={}, time_range=None, metric_defs={}, inputs_error=f"{type(exc).__name__}: {exc}"[:500])
    return out


OPS = {
    "ping": op_ping,
    "load": op_load,
    "catalog": op_catalog,
    "explain": op_explain,
    "dimension_values": op_dimension_values,
    "validate": op_validate,
    "validate_draft": op_validate_draft,
    "explain_plan": op_explain_plan,
}


def handle(line: str) -> dict[str, Any]:
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        return {"id": None, "ok": False, "error": {"code": "bad_request", "message": "not JSON"}}
    if not isinstance(req, dict):
        return {"id": None, "ok": False, "error": {"code": "bad_request", "message": "not an object"}}
    req_id = req.get("id")
    op = OPS.get(req.get("op"))
    if op is None:
        return {"id": req_id, "ok": False, "error": {"code": "bad_request", "message": f"unknown op {req.get('op')!r}"}}
    try:
        return {"id": req_id, "ok": True, "result": op(req)}
    except WorkerError as exc:
        return {"id": req_id, "ok": False, "error": {"code": exc.code, "message": exc.message}}
    except Exception as exc:  # noqa: BLE001 — reported to the caller, the worker keeps serving
        traceback.print_exc(file=sys.stderr)
        return {"id": req_id, "ok": False, "error": {"code": "internal", "message": f"{type(exc).__name__}: {exc}"}}


def main() -> None:
    _REPLY_STREAM.write(json.dumps({"id": None, "ok": True, "result": {"ready": True}}) + "\n")
    _REPLY_STREAM.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        reply = handle(line)
        _REPLY_STREAM.write(json.dumps(reply, default=str) + "\n")
        _REPLY_STREAM.flush()


if __name__ == "__main__":
    main()
