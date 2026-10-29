// Pure helpers for the dashboard builder (plan 12): the widget catalog, adding metrics to
// widgets, layout (insert / move / resize / duplicate), undo history and shaping
// results for the widgets (comparison alignment, KPI totals, bar and leaderboard joins).
// Periods are in periods.ts (re-exported here).
// Unit-tested in dashboardModel.test.ts.
import type { DashboardDoc, DashboardWidget, WidgetType } from '../../../../lib/dashboardsApi';
import type { MonitorDto, MonitorPointDto, PointKind } from '../../../../lib/monitorsApi';
import type { MetricQueryBody, SemanticCatalogDto } from '../../../../lib/semanticApi';
import { clampBand } from '../monitors/monitorView';
import { baseName, buildFilter, groupByOptions, stateFromSavedQuery } from '../lib/metricQuery';
import { parseTime, toNumber } from '../lib/metricSeries';

export * from './periods';

/** Space between widgets (px) */
export const GAP = 12;
/** The canvas has a fixed width (px), so widgets keep their size when the side panes or the window change */
export const DEFAULT_CANVAS_WIDTH = 1200;
export const MIN_CANVAS_WIDTH = 480;
export const MAX_CANVAS_WIDTH = 4000;

export function canvasWidthOf(doc: Pick<DashboardDoc, 'canvas_width'>): number {
  return clampCanvasWidth(doc.canvas_width ?? DEFAULT_CANVAS_WIDTH);
}

export function clampCanvasWidth(px: number): number {
  return Math.round(Math.max(MIN_CANVAS_WIDTH, Math.min(MAX_CANVAS_WIDTH, px)) / 10) * 10;
}
/** Widget sizes: width in percent of the canvas (fits any window), height in px */
export const MIN_WIDTH = 5;
export const MAX_WIDTH = 100;
export const MIN_HEIGHT = 60;
export const MAX_HEIGHT = 2000;
/** Resize lock points. Widths: the widget's right edge locks to a grid on the dashboard, every
 * GRID_LOCK px from its left edge, the quarter lines and the right edge (the same lines for every
 * widget, wherever it is). Heights: every GRID_LOCK px from the top of the widget's row and the
 * other widgets' heights in the row. Within the catch distance (px) the size locks, elsewhere
 * it moves freely in small steps. */
export const WIDTH_LOCKS = [25, 50, 75, 100];
export const GRID_LOCK = 100;
export const HEIGHT_LOCK = GRID_LOCK;
const STRONG_CATCH_PX = 20; // quarters, the rest of the row
const GRID_CATCH_PX = 12; // the 100 px grid, row neighbours
const HEIGHT_CATCH = 14;
const HEIGHT_STEP = 4;

// ── widget catalog ───────────────────────────────────────────────────────────

export interface WidgetTypeInfo {
  type: WidgetType;
  label: string;
  description: string;
  /** default size: percent of the canvas width, px */
  width: number;
  height: number;
  /** how many metrics it takes (0 = none) */
  maxMetrics: number;
}

export const WIDGET_TYPES: WidgetTypeInfo[] = [
  { type: 'summary', label: 'Metric summary', description: 'The total, the change vs the previous period, and a trend', width: 25, height: 200, maxMetrics: 4 },
  { type: 'timeseries', label: 'Time series', description: 'Over time, with the previous period as a gray line', width: 50, height: 300, maxMetrics: 6 },
  { type: 'bar', label: 'Bar chart', description: 'By a dimension, current and previous bars side by side', width: 50, height: 300, maxMetrics: 4 },
  { type: 'leaderboard', label: 'Top N', description: "A dimension's top values with their change", width: 33.33, height: 320, maxMetrics: 1 },
  { type: 'table', label: 'Table', description: 'Metrics by dimensions, with comparison columns', width: 50, height: 320, maxMetrics: 10 },
  { type: 'text', label: 'Text', description: 'A heading or a note', width: 100, height: 90, maxMetrics: 0 },
];

export function widgetInfo(type: WidgetType): WidgetTypeInfo {
  return WIDGET_TYPES.find((t) => t.type === type) ?? WIDGET_TYPES[0];
}

/** Categorical dimensions every metric in `metrics` can be grouped by (catalog base names). */
export function sharedDimensions(catalog: SemanticCatalogDto, metrics: string[]): string[] {
  return groupByOptions(catalog, metrics).filter((o) => o.kind === 'categorical').map((o) => o.name);
}

function metricDimensions(catalog: SemanticCatalogDto, metric: string): Set<string> {
  const m = catalog.metrics.find((x) => x.name === metric);
  return new Set((m?.dimensions ?? []).map(baseName));
}

/** A widget id (`[a-z0-9_-]`) from `base`, unique among `taken`. */
export function newWidgetId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 60) || 'widget';
  let id = stem;
  for (let n = 2; used.has(id); n += 1) id = `${stem}_${n}`;
  return id;
}

/** A new widget of `type`; bars and Top N start on the metrics' first shared dimension. */
export function newWidget(type: WidgetType, taken: Iterable<string>, metrics: string[], catalog: SemanticCatalogDto): DashboardWidget {
  const info = widgetInfo(type);
  const id = newWidgetId(metrics[0] ?? type, taken);
  const widget: DashboardWidget = { id, type, width: info.width, height: info.height, metrics: metrics.slice(0, info.maxMetrics) };
  if (type === 'text') return { ...widget, metrics: [], options: { body: '## Section' } };
  if ((type === 'bar' || type === 'leaderboard') && metrics.length) {
    const dimension = sharedDimensions(catalog, metrics)[0];
    if (dimension) return { ...widget, options: { dimension } };
  }
  return widget;
}

export type AddResult = { widget: DashboardWidget; error?: undefined } | { widget?: undefined; error: string };

/** `widget` with `metric` added, or why it can't take it. */
export function addMetric(widget: DashboardWidget, metric: string, catalog: SemanticCatalogDto): AddResult {
  const info = widgetInfo(widget.type);
  const metrics = widget.metrics ?? [];
  if (info.maxMetrics === 0) return { error: `${info.label} widgets don't show metrics` };
  if (metrics.includes(metric)) return { error: `${metric} is already here` };
  if (metrics.length >= info.maxMetrics) {
    return { error: info.maxMetrics === 1 ? `${info.label} shows one metric` : `${info.label} shows up to ${info.maxMetrics} metrics` };
  }
  const options = widget.options ?? {};
  const dims = metricDimensions(catalog, metric);
  for (const key of ['dimension', 'stack_by', 'split_by'] as const) {
    const dim = options[key];
    if (typeof dim === 'string' && !dims.has(dim)) return { error: `${metric} can't be broken down by ${dim}` };
  }
  const next = { ...widget, metrics: [...metrics, metric] };
  // A bar or Top N without a dimension picks one once it has a metric
  if ((widget.type === 'bar' || widget.type === 'leaderboard') && !options.dimension) {
    const dimension = sharedDimensions(catalog, next.metrics)[0];
    if (dimension) return { widget: { ...next, options: { ...options, dimension } } };
  }
  return { widget: next };
}

export function removeMetric(widget: DashboardWidget, metric: string): DashboardWidget {
  return { ...widget, metrics: (widget.metrics ?? []).filter((m) => m !== metric) };
}

export function widgetTitle(widget: DashboardWidget, labels: Map<string, string>): string {
  if (widget.title) return widget.title;
  if (widget.type === 'text') return 'Text';
  const metrics = widget.metrics ?? [];
  if (!metrics.length) return widgetInfo(widget.type).label;
  return metrics.map((m) => labels.get(m) ?? m).join(', ');
}

/** The type-specific option `key`, or `fallback`. */
export function opt<T>(widget: DashboardWidget, key: string, fallback: T): T {
  const value = widget.options?.[key];
  return value === undefined || value === null ? fallback : value as T;
}

export function withOption(widget: DashboardWidget, key: string, value: unknown): DashboardWidget {
  const options = { ...(widget.options ?? {}) };
  if (value === undefined || value === null || value === '') delete options[key]; else options[key] = value;
  return { ...widget, options };
}

// ── layout ───────────────────────────────────────────────────────────────────

export function replaceWidget(doc: DashboardDoc, widget: DashboardWidget): DashboardDoc {
  return { ...doc, widgets: doc.widgets.map((w) => (w.id === widget.id ? widget : w)) };
}

export function removeWidget(doc: DashboardDoc, id: string): DashboardDoc {
  return { ...doc, widgets: doc.widgets.filter((w) => w.id !== id) };
}

/** `widget` inserted at `index` (clamped; end when omitted). */
export function insertWidget(doc: DashboardDoc, widget: DashboardWidget, index?: number): DashboardDoc {
  const at = index === undefined ? doc.widgets.length : Math.max(0, Math.min(index, doc.widgets.length));
  return { ...doc, widgets: [...doc.widgets.slice(0, at), widget, ...doc.widgets.slice(at)] };
}

export function moveWidget(doc: DashboardDoc, from: number, to: number): DashboardDoc {
  if (from === to || from < 0 || to < 0 || from >= doc.widgets.length || to >= doc.widgets.length) return doc;
  const widgets = [...doc.widgets];
  const [moved] = widgets.splice(from, 1);
  widgets.splice(to, 0, moved);
  return { ...doc, widgets };
}

/** `doc` with its widgets in the order of `ids` (unknown ids ignored, missing widgets kept at the end). */
export function orderWidgets(doc: DashboardDoc, ids: string[]): DashboardDoc {
  const byId = new Map(doc.widgets.map((w) => [w.id, w]));
  const ordered = ids.map((id) => byId.get(id)).filter((w): w is DashboardWidget => !!w);
  const seen = new Set(ordered.map((w) => w.id));
  return { ...doc, widgets: [...ordered, ...doc.widgets.filter((w) => !seen.has(w.id))] };
}

/** `ids` with `moving` placed right before (or after) `target`. */
export function placeWidget(ids: string[], moving: string, target: string, after: boolean): string[] {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return ids;
  const rest = ids.filter((id) => id !== moving);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}

export function duplicateWidget(doc: DashboardDoc, id: string): DashboardDoc {
  const index = doc.widgets.findIndex((w) => w.id === id);
  if (index < 0) return doc;
  const copy = { ...doc.widgets[index], id: newWidgetId(id, doc.widgets.map((w) => w.id)) };
  return insertWidget(doc, copy, index + 1);
}

/**
 * Widths are percentages, laid out as calc(P% - gap × (1 − P/100)) so widgets whose widths add
 * up to 100 fill a row exactly, gaps included. These convert between that and pixels.
 */
export function widthCss(width: number): string {
  const p = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
  return `calc(${p}% - ${+(GAP * (1 - p / 100)).toFixed(2)}px)`;
}

export function widthToPx(width: number, container: number): number {
  return (width / 100) * (container + GAP) - GAP;
}

export function pxToWidth(px: number, container: number): number {
  return ((px + GAP) / (container + GAP)) * 100;
}

export interface Snapped {
  value: number;
  /** true when it sits on a lock point */
  locked: boolean;
}

/** The dashboard's vertical lock lines (px from its left edge): every GRID_LOCK px, the quarters, the edge. */
export function widthLockLines(container: number): { x: number; kind: 'grid' | 'quarter' | 'edge' }[] {
  const quarters = WIDTH_LOCKS.filter((l) => l < 100).map((l) => ({ x: widthToPx(l, container), kind: 'quarter' as const }));
  const grid = Array.from({ length: Math.floor((container - 1) / GRID_LOCK) }, (_, i) => ({ x: (i + 1) * GRID_LOCK, kind: 'grid' as const }));
  return [...grid, ...quarters, { x: container, kind: 'edge' }];
}

/**
 * A width % clamped to [MIN_WIDTH, max]; for a widget whose left edge is `left` px from the
 * dashboard's, its right edge locks to the dashboard's lock lines when close (quarters and the
 * edge strongly, the 100 px grid more lightly).
 */
export function snapWidth(width: number, container: number, max: number = MAX_WIDTH, left = 0): Snapped {
  const cap = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, max));
  const clamped = Math.max(MIN_WIDTH, Math.min(cap, width));
  const edge = left + widthToPx(clamped, container);
  const minPx = widthToPx(MIN_WIDTH, container);
  const capEdge = left + widthToPx(cap, container);
  const hit = widthLockLines(container)
    .map((l) => ({ ...l, catchPx: l.kind === 'grid' ? GRID_CATCH_PX : STRONG_CATCH_PX }))
    .concat({ x: capEdge, kind: 'edge', catchPx: STRONG_CATCH_PX })
    .filter((l) => l.x - left >= minPx - 0.5 && l.x <= capEdge + 0.5 && Math.abs(edge - l.x) <= l.catchPx)
    .sort((x, y) => Math.abs(edge - x.x) - Math.abs(edge - y.x))[0];
  if (hit) return { value: Math.round(Math.min(cap, pxToWidth(hit.x - left, container)) * 100) / 100, locked: true };
  return { value: Math.round(clamped * 100) / 100, locked: clamped >= cap - 0.01 };
}

/** A height locked to a multiple of HEIGHT_LOCK or a row neighbour's height when close, else 4 px steps. */
export function snapHeight(height: number, neighbours: number[] = []): Snapped {
  const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height));
  const grid = Math.round(clamped / HEIGHT_LOCK) * HEIGHT_LOCK;
  const locks = [grid, ...neighbours].filter((l) => l >= MIN_HEIGHT && l <= MAX_HEIGHT);
  const near = locks.reduce((best, l) => (Math.abs(clamped - l) < Math.abs(clamped - best) ? l : best), locks[0] ?? clamped);
  if (Math.abs(clamped - near) <= HEIGHT_CATCH) return { value: Math.round(near), locked: true };
  return { value: Math.round(clamped / HEIGHT_STEP) * HEIGHT_STEP, locked: false };
}

export interface Size {
  width: number;
  height: number;
}

export interface ResizeLimits {
  /** the widest it can get without wrapping: from its left edge to the dashboard's (percent) */
  maxWidth?: number;
  /** heights of the other widgets in its row (px), to line bottoms up */
  neighbours?: number[];
  /** px from the dashboard's left edge to the widget's (its right edge locks to the dashboard's grid) */
  left?: number;
}

export interface Resized extends Size {
  locked: { x: boolean; y: boolean };
}

/** The size after dragging a resize handle by dx/dy px (`axes`: which ones the handle moves). */
export function resized(start: Size, dx: number, dy: number, container: number, axes: { x: boolean; y: boolean },
  limits: ResizeLimits = {}): Resized {
  const w = axes.x ? snapWidth(pxToWidth(widthToPx(start.width, container) + dx, container), container, limits.maxWidth, limits.left) : null;
  const h = axes.y ? snapHeight(start.height + dy, limits.neighbours) : null;
  return {
    width: w ? w.value : start.width,
    height: h ? h.value : start.height,
    locked: { x: !!w?.locked, y: !!h?.locked },
  };
}

// ── undo history ─────────────────────────────────────────────────────────────

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const MAX_HISTORY = 100;

export function historyOf<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function record<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

// ── explorer → widget ────────────────────────────────────────────────────────

/** A widget for an explorer query: summary without group-bys, time series over time, bars otherwise. */
export function widgetFromQuery(body: MetricQueryBody, catalog: SemanticCatalogDto, taken: Iterable<string>): DashboardWidget {
  const saved = body.saved_query ? catalog.saved_queries.find((q) => q.name === body.saved_query) : null;
  const state = saved ? stateFromSavedQuery(saved) : null;
  const metrics = state ? state.metrics : body.metrics ?? [];
  const options = groupByOptions(catalog, metrics);
  const groupBy = state ? state.groupBy : (body.group_by ?? []).map((g) => {
    const idx = g.lastIndexOf('__');
    const name = idx > 0 ? g.slice(0, idx) : g;
    return options.some((o) => o.kind === 'time' && o.name === name) ? name : g;
  });
  const grainOf = state ? state.grain : (body.group_by ?? []).map((g) => g.slice(g.lastIndexOf('__') + 2)).find(Boolean);
  const time = groupBy.find((g) => options.find((o) => o.name === g)?.kind === 'time');
  const dims = groupBy.filter((g) => g !== time);
  const type: WidgetType = time ? 'timeseries' : dims.length ? 'bar' : 'summary';
  const widget = newWidget(type, taken, metrics, catalog);
  const filters = state ? state.filters : body.where ?? [];
  const opts: Record<string, unknown> = { ...(widget.options ?? {}) };
  if (type === 'timeseries') {
    if (grainOf && ['day', 'week', 'month', 'quarter', 'year'].includes(grainOf)) opts.grain = grainOf;
    if (dims[0]) opts.split_by = dims[0];
  }
  if (type === 'bar') {
    opts.dimension = dims[0];
    if (dims[1]) opts.stack_by = dims[1];
  }
  const period = body.start && body.end ? { current: { start: body.start, end: body.end } } : undefined;
  return {
    ...widget, ...(filters.length ? { filters } : {}), ...(period ? { period } : {}),
    ...(Object.keys(opts).length ? { options: opts } : {}),
  };
}

// ── shaping results ──────────────────────────────────────────────────────────

export interface Point {
  x: number;
  v: number | null;
}

/** A metric over time, oldest first. */
export function series(columns: string[], rows: unknown[][], metric: string, timeColumn: string): Point[] {
  const m = columns.indexOf(metric);
  const t = columns.indexOf(timeColumn);
  if (m < 0 || t < 0) return [];
  return rows
    .map((r) => ({ x: parseTime(r[t]), v: toNumber(r[m]) }))
    .filter((p): p is Point => p.x !== null)
    .sort((a, b) => a.x - b.x);
}

/**
 * The previous period's points drawn under the current ones: the i-th previous period
 * lines up with the i-th current one (a week ago under this week). Missing ones are null.
 */
export function alignPrevious(current: Point[], previous: Point[]): (number | null)[] {
  return current.map((_, i) => previous[i]?.v ?? null);
}

/** Separate charts when one metric's scale dwarfs another's (≥ 10×), else one chart. */
export function separateCharts(maxima: number[], layout: string): boolean {
  if (layout === 'combined') return false;
  if (layout === 'separate') return maxima.length > 1;
  const nonZero = maxima.map(Math.abs).filter((v) => v > 0);
  if (nonZero.length < 2) return false;
  return Math.max(...nonZero) / Math.min(...nonZero) >= 10;
}

export function firstValue(columns: string[], rows: unknown[][], metric: string): number | null {
  const m = columns.indexOf(metric);
  return m >= 0 && rows.length ? toNumber(rows[0][m]) : null;
}

/** (value - previous) / |previous|; null when it can't be computed. */
export function changeRatio(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return (value - previous) / Math.abs(previous);
}

export type Tone = 'good' | 'bad' | 'flat';

export function changeTone(ratio: number | null, higherIsBetter: boolean): Tone {
  if (ratio === null || Math.abs(ratio) < 0.0005) return 'flat';
  return (ratio > 0) === higherIsBetter ? 'good' : 'bad';
}

export function formatChange(ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  const pct = ratio * 100;
  const digits = Math.abs(pct) >= 10 ? 0 : 1;
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(digits)}%`;
}

export interface MetricFormat {
  format?: 'number' | 'currency' | 'percent';
  decimals?: number | null;
  currency?: string;
}

/** A value as the widget is configured: compact numbers, currency or percent (0.12 → 12%).
 * `compact`: 12.3K above 10,000; `'short'`: also above 1,000 (narrow widgets, lists). */
export function formatMetric(value: number | null | undefined, f: MetricFormat = {}, compact: boolean | 'short' = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  const digits = f.decimals ?? undefined;
  const threshold = compact === 'short' ? 1_000 : 10_000;
  const base: Intl.NumberFormatOptions = compact && Math.abs(value) >= threshold
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: digits ?? (Math.abs(value) < 1 && value !== 0 ? 3 : 2), minimumFractionDigits: digits };
  try {
    if (f.format === 'currency') return new Intl.NumberFormat(undefined, { ...base, style: 'currency', currency: f.currency || 'USD' }).format(value);
    if (f.format === 'percent') return new Intl.NumberFormat(undefined, { ...base, style: 'percent', maximumFractionDigits: digits ?? 1 }).format(value);
  } catch {
    // an unknown currency code: fall through to a plain number
  }
  return new Intl.NumberFormat(undefined, base).format(value);
}

export interface Category {
  key: string;
  value: number | null;
  previous: number | null;
}

function key(v: unknown): string {
  return v === null || v === undefined ? '∅' : String(v);
}

/** One row per value of `dimension`: current value, previous value (matched by key). */
export function categories(
  current: { columns: string[]; rows: unknown[][] }, previous: { columns: string[]; rows: unknown[][] } | null,
  dimension: string, metric: string,
): Category[] {
  const prev = new Map<string, number | null>();
  if (previous) {
    const d = previous.columns.indexOf(dimension);
    const m = previous.columns.indexOf(metric);
    if (d >= 0 && m >= 0) for (const r of previous.rows) prev.set(key(r[d]), toNumber(r[m]));
  }
  const d = current.columns.indexOf(dimension);
  const m = current.columns.indexOf(metric);
  if (d < 0 || m < 0) return [];
  return current.rows.map((r) => ({ key: key(r[d]), value: toNumber(r[m]), previous: previous ? prev.get(key(r[d])) ?? null : null }));
}

export function sortCategories(items: Category[], sort: 'value' | 'name'): Category[] {
  // null (∅) always goes last
  return [...items].sort((a, b) => Number(a.key === '∅') - Number(b.key === '∅') || (sort === 'name'
    ? a.key.localeCompare(b.key, undefined, { numeric: true })
    : (b.value ?? -Infinity) - (a.value ?? -Infinity)));
}

/** A dashboard filter for a clicked bar / row (click to filter). */
export function filterFor(dimension: string, value: string): string {
  if (value === '∅') return `{{ Dimension('${dimension}') }} is null`;
  return buildFilter({ name: dimension, kind: 'categorical', nativeGrain: null, label: null, description: null }, '=', value);
}

/** `doc` with `where` added to its filters (once). */
export function withDashboardFilter(doc: DashboardDoc, where: string): DashboardDoc {
  const filters = doc.filters ?? [];
  return filters.includes(where) ? doc : { ...doc, filters: [...filters, where] };
}

/** Metrics on the dashboard (to mark them in the rail). */
export function metricsInUse(doc: DashboardDoc): Set<string> {
  return new Set(doc.widgets.flatMap((w) => w.metrics ?? []));
}

// ── monitor overlay (Pro) ────────────────────────────────────────────────────

export interface MonitorOverlay {
  band: Map<number, [number, number]>;
  flagged: { x: number; tone: 'fail' | 'warn' }[];
}

const ALARMS = new Set<PointKind>(['anomaly', 'missing', 'zero', 'level_shift']);

/** The unsliced, enabled monitor for a time series of one unfiltered metric at the monitor's grain. */
export function monitorForWidget(monitors: MonitorDto[], widget: DashboardWidget, grain: string | null, filtered: boolean): MonitorDto | null {
  const metrics = widget.metrics ?? [];
  if (widget.type !== 'timeseries' || metrics.length !== 1 || filtered || widget.options?.split_by) return null;
  return monitors.find((m) => m.enabled && !m.dimension && m.metric === metrics[0] && m.grain === grain) ?? null;
}

export function overlayFromPoints(points: MonitorPointDto[]): MonitorOverlay {
  const band = new Map<number, [number, number]>();
  const flagged: MonitorOverlay['flagged'] = [];
  for (const p of clampBand(points)) {
    const x = Date.parse(`${p.period}T00:00:00Z`);
    if (p.low !== null && p.high !== null) band.set(x, [p.low, p.high]);
    if (p.kind !== 'none' && p.kind !== 'restated' && !p.suppressed && !p.partial) flagged.push({ x, tone: ALARMS.has(p.kind) ? 'fail' : 'warn' });
  }
  return { band, flagged };
}

/** CSV of a result (RFC 4180 quoting), for "Copy CSV". */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');
}

/** Explorer state for a query a widget ran (Open in explorer): group-by columns split into name + grain. */
export function explorerStateFromBody(body: MetricQueryBody, catalog: SemanticCatalogDto) {
  const metrics = body.metrics ?? [];
  const options = groupByOptions(catalog, metrics);
  let grain = 'day';
  const groupBy = (body.group_by ?? []).map((g) => {
    const idx = g.lastIndexOf('__');
    const name = idx > 0 ? g.slice(0, idx) : g;
    if (options.some((o) => o.kind === 'time' && o.name === name)) {
      grain = g.slice(idx + 2);
      return name;
    }
    return g;
  });
  return {
    metrics, groupBy, grain, filters: body.where ?? [], start: body.start ?? '', end: body.end ?? '',
    orderBy: [] as string[], limit: body.limit ?? null, savedQuery: null,
  };
}

/** `widget` as another type: metrics trimmed to what it takes; Bar / Top N get a dimension if they lack one. */
export function changeType(widget: DashboardWidget, type: WidgetType, catalog: SemanticCatalogDto): DashboardWidget {
  if (type === widget.type) return widget;
  const info = widgetInfo(type);
  const metrics = (widget.metrics ?? []).slice(0, info.maxMetrics);
  if (type === 'text') return { ...widget, type, metrics: [], options: { body: '## Section' } };
  const options = { ...(widget.options ?? {}) };
  delete options.body;
  if ((type === 'bar' || type === 'leaderboard') && !options.dimension && metrics.length) {
    const dimension = sharedDimensions(catalog, metrics)[0];
    if (dimension) options.dimension = dimension;
  }
  return { ...widget, type, metrics, options };
}

/** The query role a widget type can't be drawn without (results from before a type change lack it). */
export function requiredRole(type: WidgetType): string | null {
  if (type === 'text') return null;
  return type === 'summary' ? 'total' : 'current';
}

/** A rail's width after dragging its handle by `dx`, clamped (the right rail grows when dragged left). */
export function railWidth(start: number, dx: number, side: 'left' | 'right', min: number, max: number): number {
  const w = side === 'left' ? start + dx : start - dx;
  return Math.round(Math.max(min, Math.min(max, w)));
}

/**
 * What a widget's results depend on: its query settings plus the dashboard's period, grain and
 * filters (not its title or size). Results computed for another signature are out of date.
 */
/** Options that change a widget's queries (backend dashboard_plan.py); the rest only change how it's drawn. */
const QUERY_OPTIONS: Partial<Record<WidgetType, string[]>> = {
  summary: ['trend', 'show_change', 'show_previous', 'previous_line'],
  timeseries: ['grain', 'split_by'],
  bar: ['dimension', 'stack_by', 'top_n', 'show_previous'],
  table: ['period_grain', 'dimensions', 'compare_columns', 'limit'],
  leaderboard: ['dimension', 'top_n', 'show_change'],
};

export function querySignature(doc: DashboardDoc, widget: DashboardWidget): string {
  if (widget.type === 'text') return 'text';
  const { type, metrics, filters, period, options = {} } = widget;
  const queryOptions = (QUERY_OPTIONS[type] ?? []).map((k) => options[k] ?? null);
  return JSON.stringify([type, metrics ?? [], filters ?? [], period ?? null, queryOptions, doc.period ?? null, doc.grain ?? 'auto', doc.filters ?? []]);
}

/** Signatures for `doc`'s widgets (only `ids` when given). */
export function signatures(doc: DashboardDoc | null, ids?: string[]): Record<string, string> {
  if (!doc) return {};
  return Object.fromEntries(doc.widgets.filter((w) => !ids || ids.includes(w.id)).map((w) => [w.id, querySignature(doc, w)]));
}
