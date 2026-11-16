// Picking a value (plan 12 follow-up): clicking a bar, a stacked bar segment, a Top N row or
// (right-click) a table row splits the widget and shows its metrics over time for that value
// ("Show timeseries", from the query the widget ran, so its period, comparison and filters
// carry over). "Drill into…" opens a dialog of draft widgets filtered to the value — a summary,
// a breakdown by the first dimension no filter uses and a table by period — each configurable
// like any widget and addable to the dashboard. Pure; tested in drill.test.ts.
import type { DashboardDoc, DashboardWidget, DateRange, WidgetResultDto } from '../../../../lib/dashboardsApi';
import type { MetricQueryBody } from '../../../../lib/semanticApi';
import { filterFor, newWidgetId, widgetInfo, widgetTitle } from './dashboardModel';
import { rangeLabel } from './periods';

/**
 * The value(s) picked: one dimension for a bar or Top N row, the bar's and the stack's for a
 * stacked bar segment, every dimension of a table row.
 */
export interface Pick {
  values: { dimension: string; value: string }[];
  /** a time series' highlighted periods (or the period right-clicked): narrows the dates, not a dimension */
  range?: DateRange;
}

export function pickLabel(pick: Pick): string {
  const parts = pick.values.map((v) => (v.value === '∅' ? '(empty)' : v.value));
  return [...parts, ...(pick.range ? [rangeLabel(pick.range)] : [])].join(' · ');
}

export function pickKey(pick: Pick): string {
  const parts = pick.values.map((v) => `${v.dimension}=${v.value}`);
  return [...parts, ...(pick.range ? [`range=${pick.range.start}..${pick.range.end}`] : [])].join('&');
}

/** The pick spelled out: `dimension = value`, and the dates of a range. */
export function pickDescription(pick: Pick): string {
  const parts = pick.values.map((v) => `${v.dimension} = ${v.value}`);
  return [...parts, ...(pick.range ? [rangeLabel(pick.range)] : [])].join(', ');
}

/** Whether the pick is only a date range (a time series' periods). */
export function isRangeOnly(pick: Pick): boolean {
  return !!pick.range && pick.values.length === 0;
}

export function pickFilters(pick: Pick): string[] {
  return pick.values.map((v) => filterFor(v.dimension, v.value));
}

/** The dashboard with a pick's dates as its current period (comparison kept); unchanged without a range. */
export function withPickRange(doc: DashboardDoc, pick: Pick): DashboardDoc {
  if (!pick.range) return doc;
  return { ...doc, period: { current: { ...pick.range }, compare: doc.period?.compare ?? 'none' } };
}

/** The widget's query narrowed to the pick and grouped over time (no ordering or limit). */
export function drillQuery(ran: MetricQueryBody, pick: Pick, grain: string): MetricQueryBody {
  const body: MetricQueryBody = { metrics: ran.metrics ?? [], group_by: [`metric_time__${grain}`], where: [...(ran.where ?? []), ...pickFilters(pick)] };
  const start = pick.range?.start ?? ran.start;
  const end = pick.range?.end ?? ran.end;
  if (start) body.start = start;
  if (end) body.end = end;
  return body;
}

export interface QueryPair {
  current: MetricQueryBody;
  previous: MetricQueryBody | null;
}

/** The drill queries for a widget's result: the current period, and the previous one when compared. */
export function drillBodies(result: WidgetResultDto, pick: Pick): QueryPair | null {
  const current = result.queries.current;
  if (!current) return null;
  const previous = result.queries.current_previous;
  const grain = result.grain ?? 'day';
  return { current: drillQuery(current.query, pick, grain), // a range is the current period's dates: the previous period keeps its own
    previous: previous ? drillQuery(previous.query, { values: pick.values }, grain) : null };
}

/** A pseudo widget result for the drill's queries, so the time series renderer can draw it. */
export function drillResult(base: WidgetResultDto, current: { columns: string[]; rows: unknown[][] },
  previous: { columns: string[]; rows: unknown[][] } | null): WidgetResultDto {
  const q = (d: { columns: string[]; rows: unknown[][] }) => ({
    status: 'ok' as const, query: {}, sql: null, columns: d.columns, rows: d.rows, truncated: false, ran_at: null, error: null,
  });
  return {
    ...base, status: 'ok', notes: [],
    queries: { current: q(current), ...(previous ? { current_previous: q(previous) } : {}) },
  };
}

// ── Drill into… ──────────────────────────────────────────────────────────────

/** The draft widgets in Drill into…, in their places. */
export type DrilledChart = 'summary' | 'breakdown' | 'table';

export const DRILLED_CHARTS: DrilledChart[] = ['summary', 'breakdown', 'table'];

export const BREAKDOWN_TOP_N = 15;

const REFERENCE = /\{\{\s*(?:Dimension|TimeDimension|Entity)\(\s*['"](\w+)['"]/g;

/** The first of `dimensions` that none of `filters` refers to (null when every one is filtered). */
export function breakdownDimension(dimensions: string[], filters: string[]): string | null {
  const used = new Set(filters.flatMap((f) => [...f.matchAll(REFERENCE)].map((m) => m[1])));
  return dimensions.find((d) => !used.has(d)) ?? null;
}

/** Display options a drilled widget keeps from the one it came from. */
const KEPT_OPTIONS = ['format', 'decimals', 'currency', 'higher_is_better'];

/**
 * Draft widgets for Drill into…: the source widget's metrics, its own filters and period plus the
 * pick's filters. The breakdown needs its `dimension`. Ids are unique among themselves only
 * (withUniqueIds() before they go on the dashboard).
 */
export function drilledWidgets(source: DashboardWidget, pick: Pick, charts: DrilledChart[], dimension: string | null,
  labels: Map<string, string>): Partial<Record<DrilledChart, DashboardWidget>> {
  const kept = Object.fromEntries(Object.entries(source.options ?? {}).filter(([k]) => KEPT_OPTIONS.includes(k)));
  const filters = [...(source.filters ?? []), ...pickFilters(pick)];
  const name = `${widgetTitle({ ...source, title: undefined }, labels)} · ${pickLabel(pick)}`;
  const make = (type: DashboardWidget['type'], options: Record<string, unknown>, title: string): DashboardWidget => {
    const info = widgetInfo(type);
    const metrics = (source.metrics ?? []).slice(0, info.maxMetrics);
    const period = pick.range ? { ...source.period, current: pick.range } : source.period;
    return { id: `${metrics[0] ?? 'drill'}_${type}`, type, title, width: info.width, height: info.height, metrics, filters,
      ...(period ? { period } : {}), options: { ...kept, ...options } };
  };
  const out: Partial<Record<DrilledChart, DashboardWidget>> = {};
  for (const chart of charts) {
    if (chart === 'summary') out.summary = make('summary', {}, name);
    if (chart === 'table') out.table = make('table', { period_grain: 'auto' }, `${name} by period`);
    if (chart === 'breakdown' && dimension) {
      out.breakdown = { ...make('bar', { dimension, top_n: BREAKDOWN_TOP_N, orientation: 'horizontal' }, `${name} by ${dimension}`), id: `${source.metrics?.[0] ?? 'drill'}_breakdown` };
    }
  }
  return out;
}

/** `widgets` with ids unique among `taken` and each other (kept when already free). */
export function withUniqueIds(widgets: DashboardWidget[], taken: Iterable<string>): DashboardWidget[] {
  const used = new Set(taken);
  return widgets.map((w) => {
    const id = newWidgetId(w.id, used);
    used.add(id);
    return { ...w, id };
  });
}
