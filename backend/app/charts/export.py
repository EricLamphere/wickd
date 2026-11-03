"""A wickd dashboard → a dbt Charts board (Phase 3 of plan 17: "no lock-in"). Pure.

Metrics have no model to query, so each widget's query is the SQL MetricFlow explains for it
at the dashboard's period and grain (the same SQL a refresh runs), with the warehouse
relations turned back into `{{ ref('…') }}` so the board follows the active dbt target.
Widget type → chart: summary → kpi (one per metric), timeseries → line / area, bar → bar,
leaderboard → horizontal bar, table → table, text → a text row. What dct boards can't express
(previous-period comparisons, drill, monitor bands, relative periods) is dropped, with a note.
"""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import yaml

from app.semantic.dashboard_plan import (
    BarOptions,
    LeaderboardOptions,
    SummaryOptions,
    TableOptions,
    TextOptions,
    TimeseriesOptions,
    _Options,
)
from app.semantic.dashboards import Dashboard, Widget

METRIC_TIME = "metric_time"
ROW_WIDTH = 100.5  # widths are percentages of the canvas; a little slack for rounding
KPI_FORMATS = {"number": "compact", "currency": "currency_compact", "percent": "percent"}
_IDENT = re.compile(r"[^a-z0-9_]+")


@dataclass(frozen=True)
class ExportWidget:
    """One widget, planned and explained: `sql` is its main query (current period), None if it failed."""

    widget: Widget
    options: _Options
    sql: str | None = None
    group_by: tuple[str, ...] = ()
    error: str | None = None
    has_comparison: bool = False


@dataclass(frozen=True)
class ExportResult:
    text: str
    chart_count: int
    notes: tuple[str, ...] = field(default_factory=tuple)


def ident(value: str) -> str:
    out = _IDENT.sub("_", value.lower()).strip("_") or "widget"
    return out if out[0].isalpha() else f"w_{out}"


def humanize(name: str) -> str:
    base = name.split("__")[-1]
    return base.replace("_", " ").strip().capitalize() or name


def clean_sql(sql: str, relations: Mapping[str, str]) -> str:
    """MetricFlow's SQL without its `--` plan comment lines, relations → `{{ ref('model') }}`."""
    lines = [line for line in sql.strip().splitlines() if not line.lstrip().startswith("--")]
    text = "\n".join(lines).strip()
    for relation in sorted(relations, key=len, reverse=True):  # longest first: no partial overlaps
        text = text.replace(relation, "{{ ref('" + relations[relation] + "') }}")
    return text


def color_column(options: _Options) -> str | None:
    """The column that splits marks into series: dct refuses NULL categories there."""
    if isinstance(options, TimeseriesOptions):
        return options.split_by
    if isinstance(options, BarOptions):
        return options.stack_by
    return None


def fill_null_category(sql: str, column: str, others: Sequence[str]) -> str:
    """Wrap the query so NULLs in the series column read 'Unknown' (other columns passed through)."""
    rest = "".join(f", {c}" for c in others if c != column)
    inner = "\n".join(f"  {line}" for line in sql.splitlines())
    return f"SELECT COALESCE({column}, 'Unknown') AS {column}{rest}\nFROM (\n{inner}\n) AS wickd_q"


def relation_map(manifest: Mapping[str, Any]) -> dict[str, str]:
    """`relation_name` → model / seed / snapshot name for the project's own nodes."""
    project = (manifest.get("metadata") or {}).get("project_name")
    out: dict[str, str] = {}
    for node in (manifest.get("nodes") or {}).values():
        if not isinstance(node, dict) or node.get("resource_type") not in {"model", "seed", "snapshot"}:
            continue
        if project and node.get("package_name") != project:
            continue
        relation, name = node.get("relation_name"), node.get("name")
        if isinstance(relation, str) and relation and isinstance(name, str) and not node.get("version"):
            out[relation] = name
    return out


def _time_column(group_by: Sequence[str]) -> str | None:
    return next((g for g in group_by if g.startswith(f"{METRIC_TIME}__")), None)


def _title(w: Widget) -> str:
    return w.title or ", ".join(humanize(m) for m in w.metrics) or w.type.capitalize()


def _y(metrics: list[str]) -> str | list[str]:
    return metrics[0] if len(metrics) == 1 else metrics


def _charts_for(e: ExportWidget, query: str, notes: list[str]) -> list[tuple[str, dict[str, Any]]]:
    w, o = e.widget, e.options
    base = ident(w.id)
    metrics = list(w.metrics)
    if isinstance(o, SummaryOptions):
        fmt = KPI_FORMATS.get(o.format, "compact")
        return [
            (f"{base}_{ident(m)}" if len(metrics) > 1 else base,
             {"type": "kpi", "query": query, "value": m, "label": w.title if len(metrics) == 1 and w.title else humanize(m),
              "style": {"value": {"format": fmt}}})
            for m in metrics
        ]
    chart: dict[str, Any] = {"title": _title(w), "query": query}
    if isinstance(o, TimeseriesOptions):
        x = _time_column(e.group_by) or f"{METRIC_TIME}__day"
        chart |= {"type": "line" if o.style == "line" else "area", "x": x, "x_label": "Date"}
        if o.split_by:
            chart |= {"y": metrics[0], "color": o.split_by, "y_label": humanize(metrics[0])}
            if len(metrics) > 1:
                notes.append(f"{w.id}: split by {o.split_by}, so only {metrics[0]} is charted")
        else:
            chart |= {"y": _y(metrics), "y_label": humanize(metrics[0]) if len(metrics) == 1 else "Value"}
        if o.style == "stacked" and o.split_by:
            chart["style"] = {"stack": "zero"}
    elif isinstance(o, BarOptions):
        chart |= {"type": "bar", "x": o.dimension, "y": _y(metrics), "x_label": humanize(o.dimension or ""),
                  "y_label": humanize(metrics[0]) if len(metrics) == 1 else "Value"}
        style: dict[str, Any] = {"orientation": o.orientation}
        if o.stack_by:
            chart |= {"y": metrics[0], "color": o.stack_by}
            style["stack"] = "zero"
            notes.append(f"{w.id}: every {o.dimension} is exported (top {o.top_n} is picked when wickd draws it)")
        chart["style"] = style
        if o.sort == "value":
            chart["sort"] = {"by": metrics[0], "order": "desc"}
    elif isinstance(o, LeaderboardOptions):
        chart |= {"type": "bar", "x": o.dimension, "y": metrics[0], "x_label": humanize(o.dimension or ""),
                  "y_label": humanize(metrics[0]), "style": {"orientation": "horizontal"},
                  "sort": {"by": metrics[0], "order": "desc"}}
    elif isinstance(o, TableOptions):
        chart["type"] = "table"
    else:
        return []
    return [(base, chart)]


def _rows(entries: list[tuple[Widget, list[str]]]) -> list[Any]:
    """Widgets flow left to right in list order, wrapping at 100%, like the wickd canvas."""
    rows: list[Any] = []
    current: list[tuple[float, list[str]]] = []
    used = 0.0

    def flush() -> None:
        nonlocal current, used
        if len(current) == 1 and len(current[0][1]) == 1:
            rows.append(current[0][1][0])
        elif current:
            rows.append({"cols": [
                {"width": f"{round(width, 2):g}%", ("cols" if len(ids) > 1 else "rows"): ids} for width, ids in current
            ]})
        current, used = [], 0.0

    for widget, ids in entries:
        if isinstance(ids, str):  # a text widget: its own row
            flush()
            rows.append({"text": ids})
            continue
        if not ids:
            continue
        if current and used + widget.width > ROW_WIDTH:
            flush()
        current.append((widget.width, ids))
        used += widget.width
    flush()
    return rows


class _Literal(str):
    pass


def _literal(dumper: yaml.SafeDumper, value: _Literal) -> yaml.Node:
    return dumper.represent_scalar("tag:yaml.org,2002:str", str(value), style="|")


class _Dumper(yaml.SafeDumper):
    pass


_Dumper.add_representer(_Literal, _literal)


def header(dashboard: Dashboard, period_label: str | None) -> str:
    parts = [dashboard.description or "", f"Exported from the wickd dashboard **{dashboard.title}**"
             + (f" for {period_label} (fixed dates)." if period_label else ".")]
    return "\n\n".join(p for p in parts if p)


def build_board(dashboard: Dashboard, widgets: Sequence[ExportWidget], relations: Mapping[str, str],
                period_label: str | None = None) -> ExportResult:
    notes: list[str] = []
    queries: dict[str, Any] = {}
    charts: dict[str, Any] = {}
    entries: list[tuple[Widget, Any]] = []
    compared: list[str] = []
    for e in widgets:
        w = e.widget
        if isinstance(e.options, TextOptions) or w.type == "text":
            body = getattr(e.options, "body", "") or ""
            if body.strip():
                entries.append((w, body))
            continue
        if not w.metrics:
            continue
        if e.sql is None:
            notes.append(f"{w.id}: left out ({e.error or 'its query could not be explained'})")
            continue
        query = ident(w.id)
        sql = clean_sql(e.sql, relations)
        series = color_column(e.options)
        if series:
            sql = fill_null_category(sql, series, [*e.group_by, *w.metrics])
        queries[query] = _Literal(sql)
        made = _charts_for(e, query, notes)
        for chart_id, chart in made:
            charts[chart_id] = chart
        entries.append((w, [c for c, _ in made]))
        if e.has_comparison:
            compared.append(w.id)
    if compared:
        notes.append(f"previous-period comparisons aren't exported ({', '.join(compared)})")
    if any(w.period for w in dashboard.widgets):
        notes.append("widgets with their own period use it in their query; the board has no period picker")
    if dashboard.filters:
        notes.append("dashboard filters are applied inside each query (not as board variables)")
    board: dict[str, Any] = {"title": dashboard.title, "text": header(dashboard, period_label)}
    if queries:
        board |= {"queries": queries, "charts": charts, "rows": _rows(entries)}
    text = yaml.dump(board, Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=120)
    return ExportResult(text=f"# Exported from wickd ({dashboard.title})\n{text}", chart_count=len(charts),
                        notes=tuple(dict.fromkeys(notes)))
