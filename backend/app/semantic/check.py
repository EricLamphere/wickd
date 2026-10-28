"""Health → Semantic layer: MetricFlow validations, optionally against the warehouse.

validate (~7 ms in the worker) covers the `--skip-dw` half of `mf validate-configs`;
"Check against warehouse" adds a LIMIT 0 run of every metric through `dbt show`.
Results are stored as a SemanticCheckSnapshot; semantic_check_started / _finished
tell the UI.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

from app.events.bus import Event, bus
from app.logging_setup import get_logger
from app.semantic import service
from app.semantic.execute import ExecutionError, run_sql

log = get_logger(__name__)

MAX_WAREHOUSE_METRICS = 50
METRIC_TIME = "metric_time__day"

running: set[int] = set()


async def _publish(project_id: int, event_type: str, data: dict) -> None:
    await bus.publish(Event(topic=f"project:{project_id}", type=event_type, data=data))


async def _explain_for_check(project_path: Path, name: str) -> dict:
    """LIMIT 0 SQL for one metric, by day: offset and grain-to-date metrics need metric_time.
    Falls back to no group-by for a metric MetricFlow can't put on metric_time."""
    try:
        return await service.explain(project_path, {"metrics": [name], "group_by": [METRIC_TIME], "limit": 0})
    except service.SemanticError as exc:
        if exc.code != "invalid_query":
            raise
        return await service.explain(project_path, {"metrics": [name], "limit": 0})


async def _warehouse_checks(project_id: int, project_path: Path, metrics: list[str]) -> list[dict]:
    info = await service.manifest_info(project_path)
    out = []
    for name in metrics[:MAX_WAREHOUSE_METRICS]:
        try:
            explained = await _explain_for_check(project_path, name)
            await run_sql(project_id, project_path, explained["sql"], info.adapter_type, limit=1)
            out.append({"metric": name, "ok": True, "error": None})
        except (service.SemanticError, ExecutionError) as exc:
            out.append({"metric": name, "ok": False, "error": exc.message[-800:]})
    return out


async def run_check(project_id: int, project_path: Path, snapshot_id: int, *, warehouse: bool) -> None:
    from app.db import engine as db_engine  # patched in tests, like other background writers
    from app.db.models import SemanticCheckSnapshot

    status, results, error = "done", {}, None
    await _publish(project_id, "semantic_check_started", {"snapshot_id": snapshot_id, "warehouse": warehouse})
    try:
        results = await service.validate(project_path)
        if warehouse:
            catalog = await service.catalog(project_path)
            names = [m["name"] for m in catalog.get("metrics") or []]
            results["warehouse"] = await _warehouse_checks(project_id, project_path, names)
        else:
            results["warehouse"] = None
    except service.SemanticError as exc:
        status, error = "error", exc.message
    except Exception as exc:
        log.exception("semantic_check_crashed", project_id=project_id)
        status, error = "error", f"unexpected error: {exc}"
    finally:
        running.discard(project_id)

    async with db_engine.SessionLocal() as session:
        snap = await session.get(SemanticCheckSnapshot, snapshot_id)
        if snap is not None:
            snap.status = status
            snap.results_json = json.dumps(results)
            snap.error_message = error
            snap.finished_at = datetime.now(UTC)
            await session.commit()
    await _publish(project_id, "semantic_check_finished", {
        "snapshot_id": snapshot_id,
        "ok": status == "done" and not results.get("errors"),
        "errors": len(results.get("errors") or []),
        "warnings": len(results.get("warnings") or []),
    })
