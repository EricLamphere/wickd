"""Run performance insights — wickd Pro. Public shim over the private
`wickd_pro.performance` package.

Same split as app/ai/pro.py: run timing capture, the timeline, the API and the
UI are public; the analysis (critical path, regression thresholds,
recommendation rules) lives in wickd_pro. Only plain dicts/lists cross the
boundary (see app/performance/inputs.py for how they're built).

    analyze_run(nodes, parents, threads) -> dict
        nodes:   [{unique_id, name, resource_type, materialized, status, started_at,
                   completed_at, execution_time, thread_id, rows_affected,
                   bytes_processed}]  (ISO timestamps)
        parents: {unique_id: [parent unique_ids]}  (restricted to the run's nodes)
        → {has_timing, run_started_at, wall_time, ideal_time, potential_saving_s,
           threads, busy_time, utilisation, critical_path: [{unique_id, name,
           resource_type, materialized, duration_s, share, wait_before_s,
           wait_kind: "starvation" | "overhead" | None}], critical_path_waiting_s,
           starvation_s, durations: {unique_id: seconds}}
    detect_regressions(history) -> [{unique_id, name, current, baseline_median, ratio, runs_considered}]
        history: [{unique_id, name, previous: [s, …] oldest first, current: s}]  (successful runs)
    recommend(run_analysis, nodes_meta, history) -> [{kind, unique_id?, name?, title,
                                                      evidence: [str], confidence,
                                                      estimated_saving_s?}]
        nodes_meta: {unique_id: {name, resource_type, materialized, columns: [str],
                                 children: [unique_id], rows_affected?}}
        history:    {unique_id: [s, …]}  recent successful times, oldest first, incl. this run
"""

from typing import Any


class PerformanceUnavailable(Exception):
    """wickd_pro (with performance analysis) isn't installed in this build."""


def _pro() -> Any:
    try:
        from wickd_pro import performance
    except ImportError as exc:
        raise PerformanceUnavailable(
            "Performance insights require the wickd Pro package, which isn't installed in this build."
        ) from exc
    return performance


def is_available() -> bool:
    try:
        _pro()
    except PerformanceUnavailable:
        return False
    return True


def analyze_run(nodes: list[dict], parents: dict[str, list[str]], threads: int | None) -> dict:
    return _pro().analyze_run(nodes, parents, threads)


def detect_regressions(history: list[dict]) -> list[dict]:
    return _pro().detect_regressions(history)


def recommend(run_analysis: dict, nodes_meta: dict[str, dict], history: dict[str, list[float]]) -> list[dict]:
    return _pro().recommend(run_analysis, nodes_meta, history)
