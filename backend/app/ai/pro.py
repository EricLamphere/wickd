"""AI features — wickd Pro. Public shim over the private `wickd_pro.ai` package.

Same split as app/dbt/column_lineage.py: the prompts, the dbt context they're
built from and the validation of what the model returns live in wickd_pro;
this repo has the model runtime, the API, the review flow and the UI. Only
plain dicts/lists/strings cross the boundary, so neither side imports the
other's types.

    ask_messages(manifest, unique_id, history, question, run_info) -> list[message]
    explain_failure_messages(manifest, unique_id, run_info, history, question) -> list[message]
    explain_slow_messages(manifest, unique_id, perf_info, history, question) -> list[message]
    documentation_prompt(manifest, unique_id, columns) -> {"messages", "schema", "max_tokens"}
    parse_documentation(raw, columns) -> {"description": str, "columns": {name: str}}
    suggest_tests_prompt(manifest, unique_id, columns, stats, existing, candidates?) -> {"messages", "schema", "max_tokens"}
    parse_suggested_tests(raw, manifest, unique_id, columns, existing) -> [{column, test, reason, values?, to?, field?}]
    query_prompt(manifest, unique_id, history, question) -> {"messages", "schema", "max_tokens"}
    parse_query(raw) -> {"sql", "explanation"}
    metric_query_prompt(catalog, history, question) -> {"messages", "schema", "max_tokens"}
    parse_metric_query(raw, catalog) -> {metrics, group_by, where, order_by, limit, start?, end?,
        explanation} | {"fallback": "sql", "reason"}
        (Query data over defined metrics; supports_metric_query() is False on older wickd_pro)
    answer_messages(question, sql, columns, rows, truncated) -> list[message]
    refactor_prompt(manifest, unique_id, history, request) -> {"messages", "schema", "max_tokens"}
    parse_refactor_intent(raw, manifest, unique_id) -> {"op", "unique_id", "model", "new_name",
        "column"? (rename_column), "cte"? (extract_cte)} | {"op": "none", "reason"}

`run_info` is app/ai/run_context.py's node_run_info() output; `perf_info` is
app/ai/perf_context.py's node_performance_info() output.
"""

import inspect
from typing import Any


class AiUnavailable(Exception):
    """wickd_pro (with AI support) isn't installed — AI features can't run in this build."""


def _pro() -> Any:
    try:
        from wickd_pro import ai as pro_ai
    except ImportError as exc:
        raise AiUnavailable(
            "AI features require the wickd Pro package, which isn't installed in this build."
        ) from exc
    return pro_ai


def is_available() -> bool:
    try:
        _pro()
    except AiUnavailable:
        return False
    return True


def ask_messages(
    manifest: dict,
    unique_id: str | None,
    history: list[dict],
    question: str,
    run_info: dict | None = None,
) -> list[dict]:
    return _pro().ask_messages(manifest, unique_id, history, question, run_info)


def explain_failure_messages(
    manifest: dict, unique_id: str, run_info: dict, history: list[dict], question: str
) -> list[dict]:
    return _pro().explain_failure_messages(manifest, unique_id, run_info, history, question)


def explain_slow_messages(
    manifest: dict, unique_id: str, perf_info: dict, history: list[dict], question: str
) -> list[dict]:
    """Older wickd_pro builds without it get Ask with the node's context (SQL, upstream)."""
    pro_ai = _pro()
    if hasattr(pro_ai, "explain_slow_messages"):
        return pro_ai.explain_slow_messages(manifest, unique_id, perf_info, history, question)
    return pro_ai.ask_messages(manifest, unique_id, history, question, None)


def suggest_tests_prompt(
    manifest: dict,
    unique_id: str,
    columns: list[str],
    stats: dict,
    existing: list[dict],
    candidates: list[dict] | None = None,
) -> dict:
    """`candidates`: app/test_targets ranking rows for the model (columns that matter
    most go first). Dropped for older wickd_pro builds that don't take them."""
    prompt = _pro().suggest_tests_prompt
    if candidates and "candidates" in inspect.signature(prompt).parameters:
        return prompt(manifest, unique_id, columns, stats, existing, candidates)
    return prompt(manifest, unique_id, columns, stats, existing)


def parse_suggested_tests(
    raw: str, manifest: dict, unique_id: str, columns: list[str], existing: list[dict]
) -> list[dict]:
    """Raises ValueError when the model's answer isn't usable."""
    return _pro().parse_suggested_tests(raw, manifest, unique_id, columns, existing)


def documentation_prompt(manifest: dict, unique_id: str, columns: list[str]) -> dict:
    return _pro().documentation_prompt(manifest, unique_id, columns)


def parse_documentation(raw: str, columns: list[str]) -> dict:
    """Raises ValueError when the model's answer isn't usable."""
    return _pro().parse_documentation(raw, columns)


def query_prompt(manifest: dict, unique_id: str | None, history: list[dict], question: str) -> dict:
    return _pro().query_prompt(manifest, unique_id, history, question)


def parse_query(raw: str) -> dict:
    """Raises ValueError when the model's answer has no SQL."""
    return _pro().parse_query(raw)


def answer_messages(
    question: str, sql: str, columns: list[str], rows: list[list], truncated: bool
) -> list[dict]:
    return _pro().answer_messages(question, sql, columns, rows, truncated)


def refactor_prompt(manifest: dict, unique_id: str | None, history: list[dict], request: str) -> dict:
    return _pro().refactor_prompt(manifest, unique_id, history, request)


def parse_refactor_intent(raw: str, manifest: dict, unique_id: str | None) -> dict:
    """Raises ValueError when the model's answer isn't a usable operation."""
    return _pro().parse_refactor_intent(raw, manifest, unique_id)


def supports_metric_query() -> bool:
    """Whether the installed wickd_pro can turn questions into MetricFlow requests."""
    try:
        return hasattr(_pro(), "metric_query_prompt")
    except AiUnavailable:
        return False


def metric_query_prompt(catalog: dict, history: list[dict], question: str) -> dict:
    return _pro().metric_query_prompt(catalog, history, question)


def parse_metric_query(raw: str, catalog: dict) -> dict:
    return _pro().parse_metric_query(raw, catalog)
