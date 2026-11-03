"""Consumers of metrics outside the manifest, for contract checks: dashboards (files under
DASHBOARDS_PATH) and metric monitors (DB rows), keyed by metric name.

    {metric: {"dashboards": [{slug, title}], "monitors": [{id, metric, grain}]}}
"""

import asyncio
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MetricMonitor, ProjectEnvVar
from app.semantic import dashboards as store


def dashboards_by_metric(project_path: Path, setting: str | None) -> dict[str, list[dict]]:
    found: dict[str, list[dict]] = {}
    for entry in store.list_dashboards(project_path, setting):
        if entry.dashboard is None:
            continue
        for metric in dict.fromkeys(m for w in entry.dashboard.widgets for m in w.metrics):
            found.setdefault(metric, []).append({"slug": entry.slug, "title": entry.dashboard.title})
    return found


async def semantic_consumers(session: AsyncSession, project_id: int, project_path: Path) -> dict[str, dict]:
    setting = (await session.execute(
        select(ProjectEnvVar.value).where(ProjectEnvVar.project_id == project_id, ProjectEnvVar.key == store.SETTING_KEY)
    )).scalar_one_or_none()
    boards = await asyncio.to_thread(dashboards_by_metric, project_path, setting)
    monitors = (await session.execute(
        select(MetricMonitor).where(MetricMonitor.project_id == project_id).order_by(MetricMonitor.position)
    )).scalars().all()
    result: dict[str, dict] = {m: {"dashboards": d, "monitors": []} for m, d in boards.items()}
    for mon in monitors:
        entry = result.setdefault(mon.metric, {"dashboards": [], "monitors": []})
        entry["monitors"].append({"id": mon.id, "metric": mon.metric, "grain": mon.grain})
    return result
