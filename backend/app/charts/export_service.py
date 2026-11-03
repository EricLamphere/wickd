"""Export a wickd dashboard as a dbt Charts board: plan + explain each widget, then export.build_board().

Each widget's main query (the current period: `total` for summaries, else `current`) is
explained by MetricFlow exactly as a dashboard refresh would; nothing runs on the warehouse.
"""

import json
from datetime import date
from pathlib import Path

from app.charts.discovery import CHARTS_DIR
from app.charts.export import ExportResult, ExportWidget, build_board, relation_map
from app.db.models import Project
from app.semantic import service
from app.semantic.dashboard_plan import WidgetBroken, options_for, plan_widget
from app.semantic.dashboards import Dashboard
from app.semantic.query_service import explain_checked
from app.semantic.query_spec import QueryInvalid

MAIN_ROLES = ("total", "current")


def board_path(slug: str) -> str:
    return f"{CHARTS_DIR}/{slug}.yml"


def _relations(project_path: Path) -> dict[str, str]:
    try:
        manifest = json.loads((service.target_dir(project_path) / "manifest.json").read_text())
    except (OSError, ValueError):
        return {}
    return relation_map(manifest)


async def export_dashboard(project: Project, dashboard: Dashboard, adapter_type: str | None,
                           today: date | None = None) -> ExportResult:
    path = Path(project.path)
    today = today or date.today()
    catalog = await service.catalog(path)
    widgets: list[ExportWidget] = []
    period_label: str | None = None
    for widget in dashboard.widgets:
        try:
            options = options_for(widget)
        except WidgetBroken as exc:
            widgets.append(ExportWidget(widget, options=None, error=str(exc)))  # type: ignore[arg-type]
            continue
        if widget.type == "text" or not widget.metrics:
            widgets.append(ExportWidget(widget, options))
            continue
        try:
            plan = plan_widget(widget, dashboard, catalog, today)
        except WidgetBroken as exc:
            widgets.append(ExportWidget(widget, options, error=str(exc)))
            continue
        if period_label is None and plan.current is not None and widget.period is None:
            period_label = f"{plan.current.start.isoformat()} – {plan.current.end.isoformat()}"
        main = next((q for q in plan.queries if q.role in MAIN_ROLES), None)
        if main is None:
            widgets.append(ExportWidget(widget, options, error="nothing to query"))
            continue
        try:
            sql = (await explain_checked(project, main.query, adapter_type))["sql"]
        except (service.SemanticError, QueryInvalid) as exc:
            widgets.append(ExportWidget(widget, options, error=getattr(exc, "message", None) or str(exc)))
            continue
        widgets.append(ExportWidget(
            widget, options, sql=sql, group_by=tuple(main.query.get("group_by") or ()),
            has_comparison=any(q.role.endswith("_previous") for q in plan.queries),
        ))
    usable = [w for w in widgets if w.options is not None or w.sql is not None]
    broken = [w for w in widgets if w.options is None]
    result = build_board(dashboard, usable, _relations(path), period_label)
    if broken:
        extra = tuple(f"{w.widget.id}: left out ({w.error})" for w in broken)
        result = ExportResult(result.text, result.chart_count, result.notes + extra)
    return result
