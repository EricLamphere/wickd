"""Status of the Health page's checks (connection, schema drift, source freshness and,
for projects with a semantic layer, MetricFlow validations), for the overview cards,
tab badges and the nav-rail dot.

Pure: callers load the stored results; nothing here touches the DB or dbt.
"""
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

# Connection and freshness results describe a moment in time; past this they're flagged
STALE_AFTER = timedelta(days=1)

FRESHNESS_ERRORS = ("error", "runtime error")


@dataclass(frozen=True)
class CheckSummary:
    status: str  # not_run | running | ok | warn | fail
    headline: str
    issues: int  # count shown on the tab badge
    finished_at: str | None
    target: str | None
    stale_reasons: tuple[str, ...] = ()
    # False when the check can't run as things stand (MetricFlow off, or this dbt-core can't run it)
    runnable: bool = True


NOT_RUN = CheckSummary(status="not_run", headline="Not run yet", issues=0, finished_at=None, target=None)


def summarize_connection(
    result: dict[str, Any] | None, *, running: bool, current_target: str | None, now: datetime
) -> CheckSummary:
    """`result` is the stored DebugResultDto (as a dict)."""
    if running:
        return CheckSummary(status="running", headline="Running dbt debug…", issues=0,
                            finished_at=None, target=current_target)
    if result is None:
        return NOT_RUN
    finished = _parse_iso(result.get("finished_at"))
    failed = sum(1 for c in result.get("checks", []) if c.get("status") == "fail")
    if result.get("overall_ok"):
        target = result.get("target_name")
        headline = f"Connected · {target}" if target else "Connected"
        status = "ok"
    else:
        headline = f"{failed} check{_s(failed)} failed" if failed else "Connection failed"
        status = "fail"
    return CheckSummary(
        status=status,
        headline=headline,
        issues=failed or (0 if status == "ok" else 1),
        finished_at=_iso(finished),
        target=result.get("target_name"),
        stale_reasons=_stale(result.get("requested_target"), current_target, finished, now),
    )


def summarize_drift(
    snap: dict[str, Any] | None, *, rebuilt_since: int, current_target: str | None
) -> CheckSummary:
    """`snap` holds the latest drift snapshot's status, results, target, finished_at,
    total (and error_message); rebuilt_since counts its models rebuilt after it finished."""
    if snap is None:
        return NOT_RUN
    if snap["status"] == "running":
        return CheckSummary(status="running", headline=f"Checking {snap['total']} models…", issues=0,
                            finished_at=None, target=snap["target"])
    finished = _iso(snap["finished_at"])
    if snap["status"] == "error":
        return CheckSummary(status="fail", headline="Scan failed", issues=1,
                            finished_at=finished, target=snap["target"])

    results = snap["results"]
    drifted = sum(1 for r in results if r.get("has_drift"))
    not_built = sum(1 for r in results if r.get("not_built"))
    errors = sum(1 for r in results if r.get("error") and not r.get("not_built"))
    parts = [
        f"{drifted} drifted" if drifted else "",
        f"{not_built} not built" if not_built else "",
        f"{errors} error{_s(errors)}" if errors else "",
    ]
    issues = drifted + not_built + errors
    status = "fail" if errors else "warn" if issues else "ok"
    headline = " · ".join(p for p in parts if p) or f"All {len(results)} models in sync"

    reasons = []
    if rebuilt_since:
        reasons.append(f"{rebuilt_since} model{_s(rebuilt_since)} rebuilt since this scan")
    reasons.extend(_target_changed(snap["target"], current_target))
    return CheckSummary(status=status, headline=headline, issues=issues, finished_at=finished,
                        target=snap["target"], stale_reasons=tuple(reasons))


def summarize_freshness(
    snap: dict[str, Any] | None, *, current_target: str | None, now: datetime
) -> CheckSummary:
    """`snap` holds the latest freshness snapshot's status, results, target, finished_at."""
    if snap is None:
        return NOT_RUN
    if snap["status"] == "running":
        return CheckSummary(status="running", headline="Running dbt source freshness…", issues=0,
                            finished_at=None, target=snap["target"])
    finished = snap["finished_at"]
    if snap["status"] == "error":
        return CheckSummary(status="fail", headline="Freshness check failed", issues=1,
                            finished_at=_iso(finished), target=snap["target"])

    statuses = [r.get("status") for r in snap["results"]]
    errors = sum(1 for s in statuses if s in FRESHNESS_ERRORS)
    warns = statuses.count("warn")
    passes = statuses.count("pass")
    parts = [
        f"{errors} error{_s(errors)}" if errors else "",
        f"{warns} warn{_s(warns)}" if warns else "",
        f"{passes} pass" if passes else "",
    ]
    return CheckSummary(
        status="fail" if errors else "warn" if warns else "ok",
        headline=" · ".join(p for p in parts if p) or "No sources with freshness checks",
        issues=errors + warns,
        finished_at=_iso(finished),
        target=snap["target"],
        stale_reasons=_stale(snap["target"], current_target, finished, now),
    )


def summarize_semantic(
    snap: dict[str, Any] | None,
    *,
    metricflow_off: bool,
    manifest_hash: str | None,
    blocked_reason: str | None = None,
) -> CheckSummary:
    """`snap` holds the latest semantic check's status, results, finished_at, manifest_hash;
    `blocked_reason` says why this dbt-core can't run MetricFlow, if it can't."""
    if metricflow_off:
        return CheckSummary(status="not_run", headline="MetricFlow is off for this project", issues=0,
                            finished_at=None, target=None, runnable=False)
    if blocked_reason:
        return CheckSummary(status="warn", headline=blocked_reason, issues=1, finished_at=None, target=None,
                            runnable=False)
    if snap is None:
        return NOT_RUN
    if snap["status"] == "running":
        return CheckSummary(status="running", headline="Validating the semantic layer…", issues=0,
                            finished_at=None, target=None)
    finished = _iso(snap["finished_at"])
    if snap["status"] == "error":
        return CheckSummary(status="fail", headline="Check failed", issues=1, finished_at=finished, target=None)
    results = snap["results"]
    errors = len(results.get("errors") or [])
    warnings = len(results.get("warnings") or []) + len(results.get("future_errors") or [])
    warehouse = results.get("warehouse") or []
    failed = sum(1 for w in warehouse if not w.get("ok"))
    parts = [
        f"{errors} error{_s(errors)}" if errors else "",
        f"{failed} metric{_s(failed)} failed in the warehouse" if failed else "",
        f"{warnings} warning{_s(warnings)}" if warnings else "",
    ]
    reasons = ()
    recorded = snap.get("manifest_hash")
    if recorded and manifest_hash and manifest_hash != recorded:
        reasons = ("The semantic layer changed since this check",)
    return CheckSummary(
        status="fail" if errors or failed else "warn" if warnings else "ok",
        headline=" · ".join(p for p in parts if p) or "Semantic layer is valid",
        issues=errors + failed + warnings,
        finished_at=finished,
        target=None,
        stale_reasons=reasons,
    )


def summarize_metric_monitors(
    monitors: list[dict[str, Any]], *, running: bool, current_target: str | None
) -> CheckSummary:
    """`monitors`: enabled monitors' {metric, target, latest: last result | None} (Pro).

    Anomalies and refresh errors fail, warnings warn; a monitor never checked counts as
    not run. Results from another target than the current one are flagged stale."""
    if running:
        return CheckSummary(status="running", headline=f"Checking {len(monitors)} monitor{_s(len(monitors))}…",
                            issues=0, finished_at=None, target=current_target)
    results = [m["latest"] for m in monitors if m.get("latest")]
    if not results:
        return NOT_RUN
    statuses = [r.get("status") for r in results]
    anomalies, errors, warns = statuses.count("anomaly"), statuses.count("error"), statuses.count("warn")
    parts = [
        f"{anomalies} anomalous" if anomalies else "",
        f"{errors} failed to refresh" if errors else "",
        f"{warns} warning{_s(warns)}" if warns else "",
    ]
    worst = next((r for r in results if r.get("status") == "anomaly"), None)
    headline = " · ".join(p for p in parts if p) or f"All {len(results)} monitor{_s(len(results))} normal"
    if worst is not None and anomalies == 1:
        headline = f"{worst.get('metric')}: {worst.get('headline')}"
    checked = [_parse_iso(r.get("checked_at")) for r in results]
    finished = max((c for c in checked if c is not None), default=None)
    targets = {r.get("target") or None for r in results}
    unchecked = len(monitors) - len(results)
    reasons = [f"{unchecked} monitor{_s(unchecked)} never checked"] if unchecked else []
    # monitors that follow the active target but were last checked on another one
    moved = {
        m["latest"].get("target") or None for m in monitors
        if m.get("latest") and not m.get("target") and (m["latest"].get("target") or None) != (current_target or None)
    }
    if moved:
        reasons.extend(_target_changed(next(iter(moved)), current_target))
    return CheckSummary(
        status="fail" if anomalies or errors else "warn" if warns else "ok",
        headline=headline,
        issues=anomalies + errors + warns,
        finished_at=_iso(finished),
        target=next(iter(targets)) if len(targets) == 1 else None,
        stale_reasons=tuple(reasons),
    )


def _stale(
    recorded_target: str | None, current_target: str | None, finished: datetime | None, now: datetime
) -> tuple[str, ...]:
    reasons = list(_target_changed(recorded_target, current_target))
    if finished is not None and now - _aware(finished) > STALE_AFTER:
        reasons.append("Last run over a day ago")
    return tuple(reasons)


def _target_changed(recorded: str | None, current: str | None) -> tuple[str, ...]:
    if (recorded or None) == (current or None):
        return ()
    return (f"Target changed to {current or 'default'} since this run",)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _iso(dt: datetime | None) -> str | None:
    return _aware(dt).isoformat() if dt else None


def _s(n: int) -> str:
    return "" if n == 1 else "s"
