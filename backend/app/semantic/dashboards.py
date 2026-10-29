"""Metric dashboards (plan 11): YAML files in the project, `<DASHBOARDS_PATH>/<slug>.yml`.

A dashboard lives in the repo next to the metrics it shows, so it's versioned, reviewed
in the Git page and shared with the team. Widgets reference metrics by name. Layout: each
widget has a `width` (percent of the dashboard's fixed `canvas_width`) and a `height` (px), and
widgets flow left to right in list order (an optional `x`/`y` may come later; files without
them keep working). Files from before (`w` columns of 12, `h` row units) are converted on read.
A dashboard has a current period and a comparison (previous) period; widgets may
override either (plan 12).

Files are validated on read (unknown keys are kept and written back). A file that
doesn't validate is listed with its error instead of being hidden. Writes go through
a temp file + rename. Comments in a hand-edited file aren't preserved by a write from
the app.
"""

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

SETTING_KEY = "DASHBOARDS_PATH"
DEFAULT_DIR = "wickd/dashboards"
SUFFIX = ".yml"
SLUG_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,79}$"
MAX_FILE_BYTES = 512 * 1024
# The canvas has a fixed width (px), so widgets keep their size whatever the window or the
# builder's side panes do; widget widths are percentages of it
DEFAULT_CANVAS_WIDTH, MIN_CANVAS_WIDTH, MAX_CANVAS_WIDTH = 1200, 480, 4000
# Widget sizes: width in percent of the canvas, height in px
MIN_WIDTH, MAX_WIDTH = 5.0, 100.0
MIN_HEIGHT, MAX_HEIGHT = 60, 2000
# The old 12-column grid (plans 11–12 before free resizing), for converting files
LEGACY_COLUMNS, LEGACY_ROW_PX, LEGACY_GAP_PX = 12, 132, 12

_SLUG = re.compile(SLUG_PATTERN)

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Where = Annotated[str, StringConstraints(max_length=4000)]
IsoDate = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
WidgetType = Literal["summary", "timeseries", "bar", "table", "leaderboard", "text"]
PeriodPreset = Literal[
    "last_7_days", "last_30_days", "last_90_days", "last_12_months", "month_to_date", "quarter_to_date",
    "year_to_date", "last_month", "last_quarter", "all_time",
]
ComparePreset = Literal["none", "previous_period", "previous_year"]
Grain = Literal["auto", "day", "week", "month", "quarter", "year"]
MAX_WIDGETS = 40
MAX_METRICS = 10


class DashboardError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _Open(BaseModel):
    """Keeps keys it doesn't know (a newer wickd, or a hand edit) through a round-trip."""

    model_config = ConfigDict(extra="allow")


class DateRange(_Open):
    start: IsoDate
    end: IsoDate

    @model_validator(mode="after")
    def _ordered(self) -> "DateRange":
        if self.start > self.end:
            raise ValueError("a date range's start must be on or before its end")
        return self


class Period(_Open):
    current: PeriodPreset | DateRange = "last_30_days"
    compare: ComparePreset | DateRange = "previous_period"


class PeriodOverride(_Open):
    """A widget's own period; either key falls back to the dashboard's."""

    current: PeriodPreset | DateRange | None = None
    compare: ComparePreset | DateRange | None = None


def legacy_size(data: Any) -> Any:
    """`w`/`h` grid units (columns of 12, rows of 132 px + 12 px gaps) as `width` % / `height` px."""
    if not isinstance(data, dict) or ("w" not in data and "h" not in data):
        return data
    out = {k: v for k, v in data.items() if k not in ("w", "h")}
    try:
        if "width" not in out and "w" in data:
            out["width"] = round(min(LEGACY_COLUMNS, max(1, int(data["w"]))) * 100 / LEGACY_COLUMNS, 2)
        if "height" not in out and "h" in data:
            rows = max(1, int(data["h"]))
            out["height"] = rows * LEGACY_ROW_PX + (rows - 1) * LEGACY_GAP_PX
    except (TypeError, ValueError):
        return data  # leave it for validation to report
    return out


class Widget(_Open):
    id: Annotated[str, StringConstraints(pattern=SLUG_PATTERN)]
    type: WidgetType = "summary"
    title: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] | None = None
    width: float = Field(default=33.33, ge=MIN_WIDTH, le=MAX_WIDTH)
    height: int = Field(default=280, ge=MIN_HEIGHT, le=MAX_HEIGHT)
    # empty = a widget waiting for a metric (dropped from the palette); always empty for text
    metrics: list[Name] = Field(default_factory=list, max_length=MAX_METRICS)
    filters: list[Where] = Field(default_factory=list, max_length=20)
    period: PeriodOverride | None = None
    # type-specific; checked when the widget is planned (dashboard_plan.py), so a bad value
    # breaks only that widget
    options: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _legacy_size(cls, data: Any) -> Any:
        return legacy_size(data)


class Dashboard(_Open):
    version: Literal[1] = 1
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    description: Annotated[str, StringConstraints(max_length=2000)] | None = None
    period: Period = Field(default_factory=Period)
    grain: Grain = "auto"
    canvas_width: int = Field(default=DEFAULT_CANVAS_WIDTH, ge=MIN_CANVAS_WIDTH, le=MAX_CANVAS_WIDTH)
    filters: list[Where] = Field(default_factory=list, max_length=20)
    widgets: list[Widget] = Field(default_factory=list, max_length=MAX_WIDGETS)
    exposure: Annotated[str, StringConstraints(pattern=r"^[a-z_][a-z0-9_]*$")] | None = None

    @model_validator(mode="after")
    def _unique_ids(self) -> "Dashboard":
        ids = [w.id for w in self.widgets]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"widget ids must be unique: {', '.join(dupes)}")
        return self


@dataclass(frozen=True)
class DashboardEntry:
    """One file in the dashboards folder: the dashboard, or why it couldn't be read."""

    slug: str
    path: str  # relative to the project root (posix)
    dashboard: Dashboard | None
    error: str | None
    mtime: float


def dashboards_dir(project_path: Path, setting: str | None) -> Path:
    """The dashboards folder (DASHBOARDS_PATH, default wickd/dashboards), always inside the project."""
    root = project_path.resolve()
    rel = (setting or "").strip() or DEFAULT_DIR
    path = (root / rel).resolve()
    if not path.is_relative_to(root):
        raise DashboardError("bad_path", f"{SETTING_KEY} must be inside the project ({rel})")
    return path


def check_slug(slug: str) -> str:
    if not _SLUG.fullmatch(slug):
        raise DashboardError("bad_slug", "a dashboard name may only use lowercase letters, digits, `-` and `_`")
    return slug


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]
    return slug or "dashboard"


def validation_message(exc: ValidationError) -> str:
    """`widgets.0.width: Input should be less than or equal to 100; …`"""
    parts = []
    for err in exc.errors()[:5]:
        where = ".".join(str(p) for p in err.get("loc", ()))
        parts.append(f"{where}: {err.get('msg')}" if where else str(err.get("msg")))
    return "; ".join(parts)


_LEGACY_TYPES = {"kpi": "summary", "line": "timeseries", "area": "timeseries", "bar": "bar",
                 "stacked_bar": "bar", "table": "table"}
_PERIOD_PRESETS = set(PeriodPreset.__args__)


def _legacy_widget(tile: dict[str, Any]) -> dict[str, Any]:
    """A plan 11 tile as a widget: viz → type, group-bys → the type's options, where → filters."""
    viz = str(tile.get("viz") or "line")
    query = tile.get("query") if isinstance(tile.get("query"), dict) else {}
    group_by = [str(g) for g in query.get("group_by") or []]
    time = next((g for g in group_by if g.startswith("metric_time__")), None)
    dims = [g for g in group_by if g != time]
    widget: dict[str, Any] = {k: tile[k] for k in ("id", "title", "w", "h") if k in tile}  # w/h: Widget converts
    widget["type"] = _LEGACY_TYPES.get(viz, "timeseries")
    widget["metrics"] = list(query.get("metrics") or [])
    if query.get("where"):
        widget["filters"] = list(query["where"])
    if query.get("start") and query.get("end"):
        widget["period"] = {"current": {"start": query["start"], "end": query["end"]}}
    options: dict[str, Any] = {}
    if widget["type"] == "timeseries":
        if time:
            options["grain"] = time.removeprefix("metric_time__")
        if dims:
            options["split_by"] = dims[0]
        if viz == "area":
            options["style"] = "area"
    elif widget["type"] == "bar" and dims:
        options["dimension"] = dims[0]
        if viz == "stacked_bar" and len(dims) > 1:
            options["stack_by"] = dims[1]
    elif widget["type"] == "table" and dims:
        options["dimensions"] = dims[:5]
    if options:
        widget["options"] = options
    if tile.get("saved_query"):
        widget["title"] = widget.get("title") or f"Saved query {tile['saved_query']} — add its metrics again"
    return widget


def upgrade_legacy(data: dict[str, Any]) -> dict[str, Any]:
    """Plan 11's format (`tiles`, `filters.date_range`) as this one; saved as the new format next time."""
    if "tiles" not in data or "widgets" in data:
        return data
    out = {k: v for k, v in data.items() if k not in ("tiles", "filters")}
    out["widgets"] = [_legacy_widget(t) for t in data.get("tiles") or [] if isinstance(t, dict)]
    old_filters = data.get("filters") if isinstance(data.get("filters"), dict) else {}
    if old_filters.get("where"):
        out["filters"] = list(old_filters["where"])
    date_range = old_filters.get("date_range")
    if isinstance(date_range, str) and date_range in _PERIOD_PRESETS:
        out["period"] = {"current": date_range, "compare": "previous_period"}
    elif isinstance(date_range, dict) and date_range.get("start") and date_range.get("end"):
        out["period"] = {"current": {"start": date_range["start"], "end": date_range["end"]}, "compare": "previous_period"}
    return out


def parse(text: str) -> Dashboard:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise DashboardError("invalid_yaml", f"not valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise DashboardError("invalid_dashboard", "a dashboard file must be a mapping with `title` and `widgets`")
    try:
        return Dashboard.model_validate(upgrade_legacy(data))
    except ValidationError as exc:
        raise DashboardError("invalid_dashboard", validation_message(exc)) from exc


def _compact(value: Any) -> Any:
    """Drop empty lists and mappings (unset filters, a widget without filters) so files stay short."""
    if isinstance(value, dict):
        out = {k: _compact(v) for k, v in value.items()}
        return {k: v for k, v in out.items() if v not in ([], {})}
    if isinstance(value, list):
        return [_compact(v) for v in value]
    return value


def to_data(dashboard: Dashboard) -> dict[str, Any]:
    data = _compact(dashboard.model_dump(mode="json", exclude_none=True))
    return {**data, "widgets": data.get("widgets", [])}


def render(dashboard: Dashboard) -> str:
    return yaml.safe_dump(to_data(dashboard), sort_keys=False, allow_unicode=True, width=120)


def _relative(project_path: Path, path: Path) -> str:
    return path.relative_to(project_path.resolve()).as_posix()


def _entry(project_path: Path, path: Path) -> DashboardEntry:
    slug = path.stem
    try:
        stat = path.stat()
        if stat.st_size > MAX_FILE_BYTES:
            raise DashboardError("too_large", "the file is too large to be a dashboard")
        dashboard, error = parse(path.read_text(encoding="utf-8")), None
    except DashboardError as exc:
        dashboard, error = None, exc.message
    except (OSError, UnicodeDecodeError) as exc:
        dashboard, error = None, f"couldn't read the file: {exc}"
    mtime = path.stat().st_mtime if path.exists() else 0.0
    return DashboardEntry(slug=slug, path=_relative(project_path, path), dashboard=dashboard, error=error, mtime=mtime)


def list_dashboards(project_path: Path, setting: str | None) -> list[DashboardEntry]:
    folder = dashboards_dir(project_path, setting)
    if not folder.is_dir():
        return []
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix == SUFFIX and _SLUG.fullmatch(p.stem))
    return [_entry(project_path, p) for p in files]


def file_for(project_path: Path, setting: str | None, slug: str) -> Path:
    return dashboards_dir(project_path, setting) / f"{check_slug(slug)}{SUFFIX}"


def read(project_path: Path, setting: str | None, slug: str) -> DashboardEntry:
    path = file_for(project_path, setting, slug)
    if not path.is_file():
        raise DashboardError("not_found", f"there's no dashboard `{slug}`")
    return _entry(project_path, path)


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.wickd-tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def write(project_path: Path, setting: str | None, slug: str, dashboard: Dashboard, *, create: bool = False) -> DashboardEntry:
    path = file_for(project_path, setting, slug)
    if create and path.exists():
        raise DashboardError("exists", f"a dashboard named `{slug}` already exists")
    if not create and not path.is_file():
        raise DashboardError("not_found", f"there's no dashboard `{slug}`")
    _write_atomic(path, render(dashboard))
    return _entry(project_path, path)


def unique_slug(project_path: Path, setting: str | None, title: str) -> str:
    base = slugify(title)
    folder = dashboards_dir(project_path, setting)
    slug, n = base, 2
    while (folder / f"{slug}{SUFFIX}").exists():
        slug, n = f"{base}-{n}", n + 1
    return slug


def delete(project_path: Path, setting: str | None, slug: str) -> None:
    path = file_for(project_path, setting, slug)
    if not path.is_file():
        raise DashboardError("not_found", f"there's no dashboard `{slug}`")
    path.unlink()
