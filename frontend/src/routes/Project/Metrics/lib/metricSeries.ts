// Shape a metric query's rows for charts. Pure; unit-tested in metricSeries.test.ts.
//
// One panel per metric (small multiples): metrics have different scales, and a chart
// never gets a second y-axis. Within a panel the series are the dimension values,
// the top MAX_SERIES by total, coloured from the fixed categorical palette. The rest
// are left out (and counted) rather than summed into "Other": summing a ratio or an
// average metric's values would be wrong, and the Table tab has every row.

export const MAX_SERIES = 8;
export const MAX_CATEGORIES = 50;

export type PanelKind = 'line' | 'bar' | 'kpi';

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS colour, e.g. var(--series-1) */
  color: string;
}

export type ChartDatum = Record<string, number | string | null>;

export interface ChartPanel {
  metric: string;
  label: string;
  kind: PanelKind;
  /** x key in each datum: `x` (time in ms, or a category label) */
  series: ChartSeries[];
  data: ChartDatum[];
  /** dimension values not drawn (beyond MAX_SERIES) */
  hiddenSeries: number;
  /** categories not drawn (bar charts beyond MAX_CATEGORIES) */
  hiddenCategories: number;
  /** kpi only */
  value?: number | null;
}

export interface ShapeOptions {
  metrics: string[];
  /** The time group-by's column (metric_time__week), if any */
  timeColumn: string | null;
  /** Categorical group-by columns, in query order */
  dimensionColumns: string[];
  labels?: Record<string, string | null | undefined>;
}

export function seriesColor(index: number): string {
  return `var(--series-${(index % MAX_SERIES) + 1})`;
}

/** A warehouse time value as UTC ms: dates and naive timestamps are read as UTC. */
export function parseTime(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim().replace(' ', 'T');
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/.test(text);
  const iso = /^\d{4}-\d\d-\d\d$/.test(text) ? `${text}T00:00:00Z` : hasZone ? text : `${text}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function rankedKeys(totals: Map<string, number>): string[] {
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

function seriesFor(keys: string[]): ChartSeries[] {
  return keys.map((label, i) => ({ key: `s${i}`, label, color: seriesColor(i) }));
}

interface Indexed {
  metric: number;
  time: number;
  dims: number[];
  /** Series order shared by every panel (the first metric's ranking), so a value keeps its colour */
  order: string[];
}

/** `totals`' keys in the shared order first, then any others by their own totals. */
function orderedKeys(totals: Map<string, number>, shared: string[]): string[] {
  const first = shared.filter((k) => totals.has(k));
  const seen = new Set(first);
  return [...first, ...rankedKeys(totals).filter((k) => !seen.has(k))];
}

/** The first metric's series ranking: dimension values for time charts, the split for bars. */
function sharedOrder(rows: unknown[][], metric: number, time: number, dims: number[]): string[] {
  const seriesDims = time >= 0 ? dims : dims.slice(1);
  if (!seriesDims.length || metric < 0) return [];
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = dimKey(row, seriesDims);
    totals.set(key, (totals.get(key) ?? 0) + Math.abs(toNumber(row[metric]) ?? 0));
  }
  return rankedKeys(totals);
}

function dimKey(row: unknown[], dims: number[]): string {
  return dims.map((i) => (row[i] == null ? '∅' : String(row[i]))).join(' · ');
}

function timePanel(rows: unknown[][], idx: Indexed, metric: string, label: string): ChartPanel {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = idx.dims.length ? dimKey(row, idx.dims) : metric;
    totals.set(key, (totals.get(key) ?? 0) + Math.abs(toNumber(row[idx.metric]) ?? 0));
  }
  const ranked = orderedKeys(totals, idx.order);
  const shown = ranked.slice(0, MAX_SERIES);
  const series = idx.dims.length ? seriesFor(shown) : [{ key: 's0', label, color: seriesColor(0) }];
  const keyOf = new Map(shown.map((k, i) => [k, series[i].key]));
  const byTime = new Map<number, ChartDatum>();
  for (const row of rows) {
    const x = parseTime(row[idx.time]);
    const seriesKey = keyOf.get(idx.dims.length ? dimKey(row, idx.dims) : metric);
    if (x == null || !seriesKey) continue;
    const datum = byTime.get(x) ?? Object.fromEntries([['x', x], ...series.map((s) => [s.key, null])]);
    datum[seriesKey] = toNumber(row[idx.metric]);
    byTime.set(x, datum);
  }
  const data = [...byTime.values()].sort((a, b) => (a.x as number) - (b.x as number));
  return { metric, label, kind: 'line', series, data, hiddenSeries: ranked.length - shown.length, hiddenCategories: 0 };
}

function barPanel(rows: unknown[][], idx: Indexed, metric: string, label: string): ChartPanel {
  const [category, ...split] = idx.dims;
  const splitTotals = new Map<string, number>();
  const categoryTotals = new Map<string, number>();
  for (const row of rows) {
    const value = Math.abs(toNumber(row[idx.metric]) ?? 0);
    const cat = dimKey(row, [category]);
    categoryTotals.set(cat, (categoryTotals.get(cat) ?? 0) + value);
    if (split.length) splitTotals.set(dimKey(row, split), (splitTotals.get(dimKey(row, split)) ?? 0) + value);
  }
  const rankedSplit = orderedKeys(splitTotals, idx.order);
  const shownSplit = rankedSplit.slice(0, MAX_SERIES);
  const series = split.length ? seriesFor(shownSplit) : [{ key: 's0', label, color: seriesColor(0) }];
  const keyOf = new Map(shownSplit.map((k, i) => [k, series[i].key]));
  const categories = rankedKeys(categoryTotals);
  const shownCategories = categories.slice(0, MAX_CATEGORIES);
  const data = new Map<string, ChartDatum>(
    shownCategories.map((c) => [c, Object.fromEntries([['x', c], ...series.map((s) => [s.key, null])])]),
  );
  for (const row of rows) {
    const datum = data.get(dimKey(row, [category]));
    const seriesKey = split.length ? keyOf.get(dimKey(row, split)) : 's0';
    if (datum && seriesKey) datum[seriesKey] = toNumber(row[idx.metric]);
  }
  return {
    metric, label, kind: 'bar', series, data: [...data.values()],
    hiddenSeries: rankedSplit.length - shownSplit.length, hiddenCategories: categories.length - shownCategories.length,
  };
}

/** One panel per metric found in `columns`. */
export function buildPanels(columns: string[], rows: unknown[][], opts: ShapeOptions): ChartPanel[] {
  const col = (name: string) => columns.indexOf(name);
  const time = opts.timeColumn ? col(opts.timeColumn) : -1;
  const dims = opts.dimensionColumns.map(col).filter((i) => i >= 0);
  const order = sharedOrder(rows, col(opts.metrics[0] ?? ''), time, dims);
  return opts.metrics.flatMap((metric) => {
    const m = col(metric);
    if (m < 0) return [];
    const label = opts.labels?.[metric] || metric;
    const idx = { metric: m, time, dims, order };
    if (time >= 0) return [timePanel(rows, idx, metric, label)];
    if (dims.length) return [barPanel(rows, idx, metric, label)];
    return [{ metric, label, kind: 'kpi' as const, series: [], data: [], hiddenSeries: 0, hiddenCategories: 0,
      value: rows.length ? toNumber(rows[0][m]) : null }];
  });
}

/** Whether series `key` has a value at `index` with no value on either side (a line can't show it). */
export function isIsolated(data: ChartDatum[], key: string, index: number): boolean {
  const has = (i: number) => i >= 0 && i < data.length && data[i][key] != null;
  return has(index) && !has(index - 1) && !has(index + 1);
}

// ── Formatting ──────────────────────────────────────────────────────────────

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const SMALL = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });

/** Axis / tile value: compact above 10k, 3 significant digits below 1. */
export function formatValue(value: number | null | undefined, compact = true): string {
  if (value == null) return '–';
  const abs = Math.abs(value);
  if (compact && abs >= 10_000) return COMPACT.format(value);
  if (abs > 0 && abs < 1) return SMALL.format(value);
  return FULL.format(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A time tick / tooltip label at the query's grain (UTC). */
export function formatTime(ms: number, grain: string): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mon = MONTHS[d.getUTCMonth()];
  switch (grain) {
    case 'year': return String(y);
    case 'quarter': return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}`;
    case 'month': return `${mon} ${y}`;
    case 'hour': return `${mon} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    default: return `${mon} ${d.getUTCDate()}, ${y}`;
  }
}
