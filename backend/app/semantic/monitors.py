"""Metric monitor refreshes (wickd Pro): every due monitor's history in one batched
`dbt show` per dbt target (batch.run_many), stored per target and slice, then
detection through the Pro shim (anomaly.py).

Triggers (plan 10 decision 1):
- after a successful run/build that touched an ancestor of a monitored metric
  (`schedule_after_run`, called from api/runs.py);
- Check now (POST /metric-monitors/refresh);
- an optional interval while wickd is open (`MONITOR_INTERVAL_HOURS`, off by default,
  at least 1 h; one scheduler loop for all projects).

wickd only runs while it's open: this is "checked when you build or look", not 3 a.m.
alerting. One refresh per project at a time; requests that arrive meanwhile are
merged into a single follow-up. Monitors with a dimension first refresh their top
slices (weekly) in their own batch.
"""

import asyncio
import json
import os
from collections.abc import Coroutine, Iterable
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import anomaly, monitor_points
from app.semantic import monitor_queries as mq
from app.semantic.batch import BatchResult, run_many

log = get_logger(__name__)

STATUS_RANK = {"error": 4, "anomaly": 3, "warn": 2, "ok": 1, "not_enough_history": 0}
MAX_FLAGGED = 20
RECENT_POINTS = 60
INTERVAL_KEY = "MONITOR_INTERVAL_HOURS"
MIN_INTERVAL_HOURS = 1
SCHEDULER_TICK_S = 300

running: set[int] = set()
_pending: dict[int, tuple[frozenset[int] | None, str]] = {}  # project → (ids, None = all; trigger)
_tasks: set[asyncio.Task] = set()
_scheduler: asyncio.Task | None = None


class RefreshFailed(Exception):
    """The whole refresh can't run (no project, MetricFlow unavailable, no Pro package)."""


@dataclass(frozen=True)
class MonitorSpec:
    id: int
    metric: str
    grain: str
    dimension: str | None
    sensitivity: str
    lookback: int
    target: str | None  # pinned
    slices: tuple[Any, ...]
    slices_refreshed_at: datetime | None


@dataclass(frozen=True)
class _Plan:
    monitor: MonitorSpec
    window_start: date
    sql: str


def _spawn(coro: Coroutine) -> None:
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _publish(project_id: int, event_type: str, data: dict) -> None:
    await bus.publish(Event(topic=f"project:{project_id}", type=event_type, data=data))


def _as_utc(value: datetime | None) -> datetime | None:
    return value if value is None or value.tzinfo else value.replace(tzinfo=UTC)


def spec_of(row: Any) -> MonitorSpec:
    try:
        slices = json.loads(row.slices_json or "[]")
    except ValueError:
        slices = []
    return MonitorSpec(
        id=row.id, metric=row.metric, grain=row.grain, dimension=row.dimension, sensitivity=row.sensitivity,
        lookback=row.lookback, target=row.target, slices=tuple(slices if isinstance(slices, list) else []),
        slices_refreshed_at=_as_utc(row.slices_refreshed_at),
    )


# ── requests ─────────────────────────────────────────────────────────────────


async def request_refresh(project_id: int, ids: Iterable[int] | None, trigger: str) -> int | None:
    """Start a refresh of `ids` (None = every enabled monitor); its run id, or None when one
    is already running (this request then follows it, merged with any other)."""
    wanted = frozenset(ids) if ids is not None else None
    if project_id in running:
        queued_ids, _ = _pending.get(project_id, (frozenset(), trigger))
        merged = None if wanted is None or queued_ids is None else queued_ids | wanted
        _pending[project_id] = (merged, trigger)
        return None
    running.add(project_id)
    try:
        run_id = await _create_run(project_id, trigger)
    except Exception:
        running.discard(project_id)
        raise
    _spawn(_refresh(project_id, run_id, wanted, trigger))
    return run_id


async def _create_run(project_id: int, trigger: str) -> int:
    from app.db import engine as db_engine  # patched in tests, like other background writers
    from app.db.models import MetricMonitorRun

    async with db_engine.SessionLocal() as session:
        run = MetricMonitorRun(project_id=project_id, status="running", trigger=trigger)
        session.add(run)
        await session.commit()
        return run.id


async def _refresh(project_id: int, run_id: int, ids: frozenset[int] | None, trigger: str) -> None:
    results: list[dict] = []
    error: str | None = None
    try:
        results = await _refresh_all(project_id, run_id, ids, trigger)
    except (RefreshFailed, anomaly.AnomalyUnavailable) as exc:
        error = str(exc)
    except Exception as exc:
        log.exception("metric_monitor_refresh_crashed", project_id=project_id, run_id=run_id)
        error = f"unexpected error: {exc}"
    try:
        await _finish_run(run_id, results, error)
    finally:
        running.discard(project_id)
    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    await _publish(project_id, "metric_monitor_finished", {"run_id": run_id, "ok": error is None, "counts": counts})
    follow = _pending.pop(project_id, None)
    if follow is not None:
        await request_refresh(project_id, follow[0], follow[1])


async def _finish_run(run_id: int, results: list[dict], error: str | None) -> None:
    from app.db import engine as db_engine
    from app.db.models import MetricMonitorRun

    async with db_engine.SessionLocal() as session:
        run = await session.get(MetricMonitorRun, run_id)
        if run is None:
            return
        run.status = "error" if error else "done"
        run.error_message = error
        run.results_json = json.dumps([{k: v for k, v in r.items() if k != "recent"} for r in results])
        run.finished_at = datetime.now(UTC)
        await session.commit()


# ── one refresh ──────────────────────────────────────────────────────────────


async def _refresh_all(project_id: int, run_id: int, ids: frozenset[int] | None, trigger: str) -> list[dict]:
    from app.api.init import project_env
    from app.db import engine as db_engine
    from app.db.models import MetricMonitor, MetricMonitorRun, Project
    from app.semantic.status import semantic_status

    async with db_engine.SessionLocal() as session:
        project = await session.get(Project, project_id)
        if project is None:
            raise RefreshFailed("project not found")
        query = select(MetricMonitor).where(MetricMonitor.project_id == project_id, MetricMonitor.enabled.is_(True))
        if ids is not None:
            query = query.where(MetricMonitor.id.in_(ids))
        monitors = [spec_of(m) for m in (await session.execute(query.order_by(MetricMonitor.id))).scalars()]
        active = (await project_env(session, project_id, base=os.environ)).get("DBT_TARGET") or ""
        run = await session.get(MetricMonitorRun, run_id)
        if run is not None:
            run.target = active
            run.monitors_json = json.dumps([m.id for m in monitors])
            await session.commit()
        await _publish(project_id, "metric_monitor_started", {"run_id": run_id, "count": len(monitors), "trigger": trigger})
        if not monitors:
            return []
        status = await semantic_status(session, project)
        if not status.available or not status.can_query:
            raise RefreshFailed(status.reason or "MetricFlow isn't available for this project")
        if not anomaly.is_available():
            raise anomaly.AnomalyUnavailable(anomaly.UNAVAILABLE)

    by_target: dict[str, list[MonitorSpec]] = {}
    for m in monitors:
        by_target.setdefault(m.target or active, []).append(m)
    results: dict[int, dict] = {}
    for target, group in by_target.items():
        results.update(await _refresh_target(project, status.adapter_type, target, group, run_id))
    return [results[m.id] for m in monitors]


async def _progress(project_id: int, run_id: int, step: str, total: int) -> None:
    await _publish(project_id, "metric_monitor_progress", {"run_id": run_id, "step": step, "total": total})


async def _explain(project: Any, query: dict, adapter_type: str | None) -> str:
    from app.semantic.query_service import explain_checked

    return (await explain_checked(project, query, adapter_type))["sql"]


def _explain_errors() -> tuple[type[Exception], ...]:
    from app.semantic.query_spec import QueryInvalid
    from app.semantic.runtime import RuntimeUnavailable
    from app.semantic.service import SemanticError

    return (SemanticError, QueryInvalid, RuntimeUnavailable)


def _message(exc: Exception) -> str:
    return getattr(exc, "message", None) or str(exc)


async def _refresh_target(
    project: Any, adapter_type: str | None, target: str, monitors: list[MonitorSpec], run_id: int
) -> dict[int, dict]:
    today = date.today()
    results: dict[int, dict] = {}
    monitors = await _refresh_slices(project, adapter_type, target, monitors, today, results, run_id)
    plans: list[_Plan] = []
    for m in monitors:
        try:
            plans.append(await _plan(project, adapter_type, target, m, today))
        except _explain_errors() as exc:
            results[m.id] = _error(m, target, _message(exc))
    if not plans:
        return results
    await _progress(project.id, run_id, "querying", len(plans))
    batch = await run_many(project.id, Path(project.path), [p.sql for p in plans], target=target or None)
    await _progress(project.id, run_id, "detecting", len(plans))
    for plan, res in zip(plans, batch, strict=True):
        results[plan.monitor.id] = await _store_and_detect(plan, res, target, today)
    return results


async def _plan(project: Any, adapter_type: str | None, target: str, m: MonitorSpec, today: date) -> _Plan:
    from app.db import engine as db_engine

    keys = _slice_keys(m)
    async with db_engine.SessionLocal() as session:
        history = await monitor_points.has_history(session, m.id, target, keys)
    start = mq.window_start(today, m.grain, m.lookback, has_history=history)
    query = mq.series_query(m.metric, m.grain, m.dimension, m.slices, start)
    return _Plan(monitor=m, window_start=start, sql=await _explain(project, query, adapter_type))


def _slice_keys(m: MonitorSpec) -> list[str]:
    return [mq.slice_key(s) for s in m.slices] if m.dimension else [mq.UNSLICED]


def _slices_due(m: MonitorSpec, now: datetime) -> bool:
    if not m.dimension:
        return False
    return not m.slices or m.slices_refreshed_at is None or now - m.slices_refreshed_at >= mq.SLICE_REFRESH


async def _refresh_slices(
    project: Any, adapter_type: str | None, target: str, monitors: list[MonitorSpec], today: date,
    results: dict[int, dict], run_id: int,
) -> list[MonitorSpec]:
    """Recompute top slices where due; the monitors that can go on (errors go to `results`)."""
    now = datetime.now(UTC)
    due: list[tuple[MonitorSpec, str]] = []
    for m in (m for m in monitors if _slices_due(m, now)):
        start = mq.window_start(today, m.grain, m.lookback, has_history=False)
        try:
            due.append((m, await _explain(project, mq.totals_query(m.metric, m.dimension or "", start), adapter_type)))
        except _explain_errors() as exc:
            results[m.id] = _error(m, target, _message(exc))
    updated: dict[int, MonitorSpec] = {}
    if due:
        await _progress(project.id, run_id, "slices", len(due))
        batch = await run_many(project.id, Path(project.path), [sql for _, sql in due], target=target or None)
        for (m, _), res in zip(due, batch, strict=True):
            slices = _top_slices(m, res)
            if isinstance(slices, str):
                results[m.id] = _error(m, target, slices)
            else:
                updated[m.id] = replace(m, slices=tuple(slices), slices_refreshed_at=now)
        await _save_slices(list(updated.values()), now)
    return [updated.get(m.id, m) for m in monitors if m.id not in results]


def _top_slices(m: MonitorSpec, res: BatchResult) -> list[Any] | str:
    """The top slices, or an error message."""
    if res.error:
        return res.error
    try:
        totals = mq.parse_totals(res.columns, res.rows, m.metric, m.dimension or "")
    except ValueError as exc:
        return str(exc)
    usable = [t for t in totals if mq.filterable_slices([t["slice"]])]
    slices = anomaly.slice_values(usable, mq.TOP_SLICES)
    return slices or f"`{m.dimension}` has no values to slice by"


async def _save_slices(monitors: list[MonitorSpec], now: datetime) -> None:
    from app.db import engine as db_engine
    from app.db.models import MetricMonitor

    async with db_engine.SessionLocal() as session:
        for m in monitors:
            row = await session.get(MetricMonitor, m.id)
            if row is not None:
                row.slices_json = json.dumps(list(m.slices))
                row.slices_refreshed_at = now
        await session.commit()


async def _store_and_detect(plan: _Plan, res: BatchResult, target: str, today: date) -> dict:
    from app.db import engine as db_engine
    from app.db.models import MetricMonitor

    m = plan.monitor
    if res.error:
        return _error(m, target, res.error)
    try:
        parsed = mq.parse_series(res.columns, res.rows, m.metric, m.grain, m.dimension)
    except ValueError as exc:
        return _error(m, target, str(exc))
    now = datetime.now(UTC)
    lookback_start = mq.window_start(today, m.grain, m.lookback, has_history=False).isoformat()
    async with db_engine.SessionLocal() as session:
        slices = []
        for key in _slice_keys(m):
            previous = await monitor_points.upsert(
                session, m.id, target, key, sorted(parsed.get(key, [])),
                grain=m.grain, now=now, window_start=plan.window_start.isoformat(),
            )
            await session.flush()
            series = await monitor_points.series(session, m.id, target, key, lookback_start)
            detected = anomaly.detect(series, grain=m.grain, sensitivity=m.sensitivity, previous=previous, now=today)
            slices.append(slice_result(key, detected))
        await monitor_points.trim(session, m.id, target, lookback_start)
        result = monitor_result(m, target, slices, truncated=res.truncated, checked_at=now)
        row = await session.get(MetricMonitor, m.id)
        if row is not None:
            row.last_result_json = json.dumps(result)
            row.last_checked_at = now
        await session.commit()
    return result


# ── results (pure) ───────────────────────────────────────────────────────────


def _compact(point: dict) -> dict:
    keys = ("period", "value", "expected", "low", "high", "kind", "partial")
    return {k: point.get(k) for k in keys}


def slice_result(key: str, detected: dict) -> dict:
    summary, points = detected["summary"], detected["points"]
    flagged = [_compact(p) | {"score": p.get("score")} for p in points if p["kind"] != "none"]
    return {
        "slice": key,
        "status": summary["status"],
        "headline": summary["headline"],
        "since": summary.get("since"),
        "latest": summary.get("latest"),
        "counts": summary.get("counts") or {},
        "restated": summary.get("restated") or 0,
        "flagged": flagged[-MAX_FLAGGED:],
        "recent": [_compact(p) for p in points[-RECENT_POINTS:]],
    }


def monitor_result(m: MonitorSpec, target: str, slices: list[dict], *, truncated: bool, checked_at: datetime) -> dict:
    worst = max(slices, key=lambda s: STATUS_RANK.get(s["status"], 0))
    prefix = f"{worst['slice']}: " if m.dimension and worst["status"] not in ("ok", "not_enough_history") else ""
    return {
        "monitor_id": m.id, "metric": m.metric, "grain": m.grain, "dimension": m.dimension, "target": target,
        "status": worst["status"], "headline": prefix + worst["headline"], "since": worst.get("since"),
        "latest": worst.get("latest"), "worst_slice": worst["slice"] if m.dimension else None,
        "slices": [{k: v for k, v in s.items() if k != "recent"} for s in slices],
        "recent": worst["recent"], "truncated": truncated, "error": None, "checked_at": checked_at.isoformat(),
    }


def _error(m: MonitorSpec, target: str, message: str) -> dict:
    return {
        "monitor_id": m.id, "metric": m.metric, "grain": m.grain, "dimension": m.dimension, "target": target,
        "status": "error", "headline": "Couldn't refresh this monitor", "since": None, "latest": None,
        "worst_slice": None, "slices": [], "recent": [], "truncated": False, "error": message[-1500:],
        "checked_at": datetime.now(UTC).isoformat(),
    }


# ── after a run / build ──────────────────────────────────────────────────────


async def _entitled(session: Any) -> bool:
    from app.licensing import entitlements

    return anomaly.is_available() and (await entitlements.check_entitlement(session)).entitled


def schedule_after_run(project_id: int, project_path: Path, succeeded: set[str]) -> None:
    """Refresh the monitors downstream of what a run just built (in the background)."""
    if succeeded:
        _spawn(_after_run(project_id, project_path, succeeded))


async def _after_run(project_id: int, project_path: Path, succeeded: set[str]) -> None:
    from app.db import engine as db_engine
    from app.db.models import MetricMonitor
    from app.dbt.manifest import load_manifest
    from app.semantic.service import target_dir

    try:
        async with db_engine.SessionLocal() as session:
            monitors = (await session.execute(
                select(MetricMonitor.id, MetricMonitor.metric)
                .where(MetricMonitor.project_id == project_id, MetricMonitor.enabled.is_(True))
            )).all()
            if not monitors or not await _entitled(session):
                return
        manifest = await asyncio.to_thread(load_manifest, target_dir(project_path) / "manifest.json")
        if manifest is None:
            return
        uids = {n.name: n.unique_id for n in manifest.nodes if n.resource_type == "metric"}
        ids = mq.affected_monitors([(i, m) for i, m in monitors], uids, manifest.parents, succeeded)
        if ids:
            await request_refresh(project_id, ids, "build")
    except Exception:
        log.exception("metric_monitor_after_run_failed", project_id=project_id)


# ── interval while open ──────────────────────────────────────────────────────


def parse_interval(raw: str | None) -> int | None:
    """Hours between automatic refreshes, None when off (empty, invalid or under the minimum)."""
    text = (raw or "").strip()
    if not text.isdigit():
        return None
    hours = int(text)
    return hours if hours >= MIN_INTERVAL_HOURS else None


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is None or _scheduler.done():
        _scheduler = asyncio.create_task(_scheduler_loop())


async def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.cancel()
        try:
            await _scheduler
        except asyncio.CancelledError:
            pass
        _scheduler = None


async def _scheduler_loop() -> None:
    while True:
        await asyncio.sleep(SCHEDULER_TICK_S)
        try:
            await tick(datetime.now(UTC))
        except Exception:
            log.exception("metric_monitor_scheduler_failed")


async def tick(now: datetime) -> list[int]:
    """Start the interval refreshes that are due; the project ids started."""
    from app.db import engine as db_engine
    from app.db.models import MetricMonitor, MetricMonitorRun, ProjectEnvVar

    async with db_engine.SessionLocal() as session:
        rows = (await session.execute(
            select(ProjectEnvVar.project_id, ProjectEnvVar.value).where(ProjectEnvVar.key == INTERVAL_KEY)
        )).all()
        due = []
        for project_id, raw in rows:
            hours = parse_interval(raw)
            if hours is None or project_id in running:
                continue
            enabled = (await session.execute(
                select(func.count()).select_from(MetricMonitor)
                .where(MetricMonitor.project_id == project_id, MetricMonitor.enabled.is_(True))
            )).scalar_one()
            last = (await session.execute(
                select(func.max(MetricMonitorRun.started_at)).where(MetricMonitorRun.project_id == project_id)
            )).scalar_one_or_none()
            if enabled and (last is None or now - _as_utc(last) >= timedelta(hours=hours)):
                due.append(project_id)
        if not due or not await _entitled(session):
            return []
    for project_id in due:
        await request_refresh(project_id, None, "interval")
    return due
