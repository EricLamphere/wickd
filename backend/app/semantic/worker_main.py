"""MetricFlow worker: semantic_manifest.json + dialect → SQL. Never connects to a warehouse.

STANDALONE: run by the MetricFlow sidecar venv's Python (see sidecar_env.py), not by
the backend, so it must not import anything from `app`. Shipped next to the backend
as a PyInstaller data file.

Protocol: one JSON object per line on stdin, one reply per line on stdout.
  request  {"id": "...", "op": "...", "manifest_path": "...", "dialect": "duckdb", ...}
  reply    {"id": "...", "ok": true, "result": {...}}
         | {"id": "...", "ok": false, "error": {"code": "...", "message": "..."}}

Ops: ping, load, catalog, explain, dimension_values, validate, validate_draft. MetricFlow prints
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


OPS = {
    "ping": op_ping,
    "load": op_load,
    "catalog": op_catalog,
    "explain": op_explain,
    "dimension_values": op_dimension_values,
    "validate": op_validate,
    "validate_draft": op_validate_draft,
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
