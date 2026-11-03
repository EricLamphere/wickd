"""Metric debugging's "Why is this number this?" — wickd Pro (plan 15). Public shim over the
private `wickd_pro.metric_debug` module.

Every check is public (semantic/debug*.py); writing them up as an explanation and ranking the
likely cause is Pro. Only plain dicts/lists/strings cross the boundary:

    explain(context) -> {headline, points: [{text, finding_ids, severity}], causes: [{title, finding_ids, score}]}
        context: {metrics, query, definitions: {metric: {type, label, description, filter, inputs}},
                  plan, checks (findings), notes, result: {columns, rows} | None}
"""

from typing import Any


class MetricDebugUnavailable(Exception):
    """wickd_pro (with metric debugging) isn't installed in this build."""


def _pro() -> Any:
    try:
        from wickd_pro import metric_debug
    except ImportError as exc:
        raise MetricDebugUnavailable(
            "Explaining a metric requires the wickd Pro package, which isn't installed in this build."
        ) from exc
    return metric_debug


def is_available() -> bool:
    try:
        _pro()
    except MetricDebugUnavailable:
        return False
    return True


def explain(context: dict[str, Any]) -> dict[str, Any]:
    return _pro().explain(context)
