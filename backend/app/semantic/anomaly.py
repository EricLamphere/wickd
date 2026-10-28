"""Metric anomaly detection — wickd Pro. Public shim over the private `wickd_pro.anomaly`.

Same split as app/performance/pro.py: monitors, their history, the batched warehouse
queries, the API and the UI are public; the detection (baselines, scores, thresholds,
level shifts, restatements) and the slice ranking live in wickd_pro. Only plain dicts
and lists cross the boundary.

    detect(series, *, grain, sensitivity, previous, now) -> {points, summary}
        series:   [{period: 'YYYY-MM-DD', value: float | None, suppressed?: bool}]
        previous: [{period, value, observed_at}]  values stored before this refresh
        now:      date (the period containing it is partial)
        → points: [{period, value, expected, low, high, score, partial, suppressed,
                    restated, previous,
                    kind: none|warn|anomaly|missing|zero|restated|level_shift,
                    shift?: {direction: up|down, since}}]  every period, gaps filled
          summary: {status: ok|warn|anomaly|not_enough_history, headline, latest_kind,
                    since, latest: {period, value, expected} | None, counts: {kind: n},
                    restated}
        ValueError for an unknown grain or sensitivity.
    slice_values(totals, limit) -> [slice]
        totals: [{slice, total}]  → the top `limit` slices
"""

from datetime import date
from typing import Any

UNAVAILABLE = "Metric monitors require the wickd Pro package, which isn't installed in this build."
SENSITIVITIES = ("low", "normal", "high")


class AnomalyUnavailable(Exception):
    """wickd_pro (with anomaly detection) isn't installed in this build."""


def _pro() -> Any:
    try:
        from wickd_pro import anomaly
    except ImportError as exc:
        raise AnomalyUnavailable(UNAVAILABLE) from exc
    return anomaly


def is_available() -> bool:
    try:
        _pro()
    except AnomalyUnavailable:
        return False
    return True


def detect(
    series: list[dict], *, grain: str, sensitivity: str, previous: list[dict] | None, now: date
) -> dict:
    return _pro().detect(series, grain=grain, sensitivity=sensitivity, previous=previous, now=now)


def slice_values(totals: list[dict], limit: int) -> list:
    return _pro().slice_values(totals, limit)
