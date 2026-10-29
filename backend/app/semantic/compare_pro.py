"""Metric compare mode — wickd Pro (plan 14). Public shim over the private
`wickd_pro.metric_compare` module.

Running both sides is public (semantic/compare.py, revisions.py); aligning them and saying what
moved is Pro. Only plain dicts/lists/strings cross the boundary:

    align(current, base, key_columns, metrics, *, base_metrics=None, tolerance=1e-6) -> [row]
        current / base: {"columns": [...], "rows": [[...]]}
        → [{key: [...], status: same|changed|only_current|only_base,
            values: {metric: {current, base, delta, pct, changed}}}]
    summarize(rows, key_columns, metrics, *, time_column=None, side_names=("now", "before"))
        -> {total, same, changed,
        only_current, only_base, headline, largest: [...], by_dimension: [...],
        shape: none|level|localized}
    sql_diff(current_sql, base_sql, dialect=None) -> unified diff ("" when the same)
"""

from typing import Any


class MetricCompareUnavailable(Exception):
    """wickd_pro (with metric compare) isn't installed in this build."""


def _pro() -> Any:
    try:
        from wickd_pro import metric_compare
    except ImportError as exc:
        raise MetricCompareUnavailable(
            "Metric compare requires the wickd Pro package, which isn't installed in this build."
        ) from exc
    return metric_compare


def is_available() -> bool:
    try:
        _pro()
    except MetricCompareUnavailable:
        return False
    return True


def align(current: dict, base: dict, key_columns: list[str], metrics: list[str], *,
          base_metrics: dict[str, str] | None = None) -> list[dict]:
    return _pro().align(current, base, key_columns, metrics, base_metrics=base_metrics)


def summarize(rows: list[dict], key_columns: list[str], metrics: list[str], *, time_column: str | None = None,
              side_names: tuple[str, str] = ("now", "before")) -> dict:
    return _pro().summarize(rows, key_columns, metrics, time_column=time_column, side_names=side_names)


def sql_diff(current_sql: str, base_sql: str, dialect: str | None = None) -> str:
    return _pro().sql_diff(current_sql, base_sql, dialect)
