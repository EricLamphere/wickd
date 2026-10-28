// The Metrics page's query: explorer state ⇄ URL search params ⇄ MetricFlow request.
// Pure; unit-tested in metricQuery.test.ts.
import type { CatalogDimension, CatalogMetric, MetricQueryBody, SemanticCatalogDto } from '../../../../lib/semanticApi';

/** Finest → coarsest; a time dimension can be grouped at its own grain or any coarser one. */
export const GRAIN_ORDER = [
  'nanosecond', 'microsecond', 'millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year',
] as const;
const PICKABLE_GRAINS = ['hour', 'day', 'week', 'month', 'quarter', 'year'];
export const DEFAULT_GRAIN = 'day';
export const METRIC_TIME = 'metric_time';

export interface GroupByOption {
  /** Name without a grain suffix: metric_time, customer__country, order__order_date */
  name: string;
  kind: 'time' | 'categorical';
  /** A time dimension's native grain (day for metric_time__day) */
  nativeGrain: string | null;
  label: string | null;
  description: string | null;
}

export interface ExplorerState {
  metrics: string[];
  groupBy: string[];
  grain: string;
  /** MetricFlow `where` strings, e.g. {{ Dimension('customer__country') }} = 'US' */
  filters: string[];
  start: string;
  end: string;
  /** Group-by or metric names; a leading `-` sorts descending */
  orderBy: string[];
  limit: number | null;
  savedQuery: string | null;
}

export const EMPTY_STATE: ExplorerState = {
  metrics: [], groupBy: [], grain: DEFAULT_GRAIN, filters: [], start: '', end: '', orderBy: [], limit: null, savedQuery: null,
};

const PARAM_KEYS = ['metrics', 'group_by', 'grain', 'where', 'start', 'end', 'order_by', 'limit', 'saved'] as const;

function list(value: string | null): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function stateFromParams(params: URLSearchParams): ExplorerState {
  const limit = Number(params.get('limit'));
  return {
    metrics: list(params.get('metrics')),
    groupBy: list(params.get('group_by')),
    grain: params.get('grain') || DEFAULT_GRAIN,
    filters: params.getAll('where').filter(Boolean),
    start: params.get('start') ?? '',
    end: params.get('end') ?? '',
    orderBy: list(params.get('order_by')),
    limit: Number.isInteger(limit) && limit > 0 ? limit : null,
    savedQuery: params.get('saved') || null,
  };
}

/** `prev` with the explorer's params replaced by `state` (other params, e.g. tabs, are kept). */
export function writeState(prev: URLSearchParams, state: ExplorerState): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const key of PARAM_KEYS) next.delete(key);
  if (state.savedQuery) {
    next.set('saved', state.savedQuery);
    return next;
  }
  if (state.metrics.length) next.set('metrics', state.metrics.join(','));
  if (state.groupBy.length) next.set('group_by', state.groupBy.join(','));
  if (state.grain !== DEFAULT_GRAIN) next.set('grain', state.grain);
  for (const where of state.filters) next.append('where', where);
  if (state.start) next.set('start', state.start);
  if (state.end) next.set('end', state.end);
  if (state.orderBy.length) next.set('order_by', state.orderBy.join(','));
  if (state.limit) next.set('limit', String(state.limit));
  return next;
}

/** A catalog dimension's name without its grain suffix (metric_time__day → metric_time). */
export function baseName(d: CatalogDimension): string {
  const suffix = d.time_granularity ? `__${d.time_granularity}` : '';
  return d.type === 'time' && suffix && d.name.endsWith(suffix) ? d.name.slice(0, -suffix.length) : d.name;
}

function optionFor(d: CatalogDimension): GroupByOption {
  const time = d.type === 'time';
  return { name: baseName(d), kind: time ? 'time' : 'categorical', nativeGrain: time ? d.time_granularity : null,
    label: d.label, description: d.description };
}

function sortOptions(a: GroupByOption, b: GroupByOption): number {
  const rank = (o: GroupByOption) => (o.name === METRIC_TIME ? 0 : o.kind === 'time' ? 1 : 2);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/** Group-bys valid for every selected metric (all of the first metric's when none is selected). */
export function groupByOptions(catalog: SemanticCatalogDto | undefined, metrics: string[]): GroupByOption[] {
  if (!catalog) return [];
  const byName = new Map(catalog.metrics.map((m) => [m.name, m]));
  const selected = metrics.map((m) => byName.get(m)).filter((m): m is CatalogMetric => !!m);
  if (!selected.length) return [];
  const [first, ...rest] = selected.map((m) => new Map(m.dimensions.map((d) => [baseName(d), d])));
  return [...first.entries()]
    .filter(([name]) => rest.every((dims) => dims.has(name)))
    .map(([, d]) => optionFor(d))
    .sort(sortOptions);
}

/** Grains a time group-by can use: its native grain and coarser (day…year by default). */
export function allowedGrains(options: GroupByOption[], groupBy: string[]): string[] {
  const natives = options.filter((o) => o.kind === 'time' && groupBy.includes(o.name)).map((o) => o.nativeGrain ?? DEFAULT_GRAIN);
  const finest = natives.length ? Math.max(...natives.map((g) => GRAIN_ORDER.indexOf(g as never))) : GRAIN_ORDER.indexOf(DEFAULT_GRAIN);
  return PICKABLE_GRAINS.filter((g) => GRAIN_ORDER.indexOf(g as never) >= finest);
}

/** The column MetricFlow returns for a group-by (time ones carry the grain). */
export function groupByColumn(name: string, options: GroupByOption[], grain: string): string {
  const option = options.find((o) => o.name === name);
  return option?.kind === 'time' ? `${name}__${grain}` : name;
}

function orderColumn(entry: string, options: GroupByOption[], grain: string): string {
  const desc = entry.startsWith('-');
  const name = desc ? entry.slice(1) : entry;
  return `${desc ? '-' : ''}${groupByColumn(name, options, grain)}`;
}

/** The MetricFlow request for `state` (null when nothing is picked yet). */
export function toRequest(state: ExplorerState, options: GroupByOption[]): MetricQueryBody | null {
  if (state.savedQuery) return { saved_query: state.savedQuery };
  if (!state.metrics.length) return null;
  const groupBy = state.groupBy.filter((g) => options.some((o) => o.name === g));
  const time = groupBy.find((g) => options.find((o) => o.name === g)?.kind === 'time');
  // Newest first by default, so a truncated result keeps the latest periods
  const orderBy = state.orderBy.length ? state.orderBy : time ? [`-${time}`] : [];
  const body: MetricQueryBody = { metrics: state.metrics };
  if (groupBy.length) body.group_by = groupBy.map((g) => groupByColumn(g, options, state.grain));
  if (state.filters.length) body.where = state.filters;
  if (orderBy.length) body.order_by = orderBy.map((o) => orderColumn(o, options, state.grain));
  if (state.limit) body.limit = state.limit;
  if (state.start) body.start = state.start;
  if (state.end) body.end = state.end;
  return body;
}

/** State that opens a saved query's definition in the explorer (to edit it). */
export function stateFromSavedQuery(saved: { metrics: string[]; group_by: string[]; where: string[] }): ExplorerState {
  const groupBy: string[] = [];
  let grain = DEFAULT_GRAIN;
  for (const g of saved.group_by) {
    const time = g.match(/^TimeDimension\(\s*['"](\w+)['"](?:\s*,\s*['"](\w+)['"])?\s*\)$/);
    const dim = g.match(/^(?:Dimension|Entity)\(\s*['"](\w+)['"]\s*\)$/);
    if (time) {
      groupBy.push(time[1]);
      if (time[2]) grain = time[2];
    } else if (dim) groupBy.push(dim[1]);
    else groupBy.push(g);
  }
  return { ...EMPTY_STATE, metrics: saved.metrics, groupBy, grain, filters: saved.where };
}

// ── Date range presets ──────────────────────────────────────────────────────

export const DATE_PRESETS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: '12m', label: 'Last 12 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'all', label: 'All time' },
] as const;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** {start, end} for a preset, relative to `today` (UTC dates). */
export function presetRange(key: string, today: Date = new Date()): { start: string; end: string } {
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const minus = (days: number) => isoDay(new Date(day.getTime() - days * 86_400_000));
  switch (key) {
    case '7d': return { start: minus(6), end: '' };
    case '30d': return { start: minus(29), end: '' };
    case '90d': return { start: minus(89), end: '' };
    case '12m': return { start: isoDay(new Date(Date.UTC(day.getUTCFullYear() - 1, day.getUTCMonth(), day.getUTCDate() + 1))), end: '' };
    case 'ytd': return { start: `${day.getUTCFullYear()}-01-01`, end: '' };
    default: return { start: '', end: '' };
  }
}

// ── Filters ─────────────────────────────────────────────────────────────────

export const FILTER_OPS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'like', 'is null', 'is not null'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

function literal(value: string): string {
  const v = value.trim();
  return /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
}

/** A `where` string from the filter builder: dimension, operator, value (comma-separated for in). */
export function buildFilter(option: GroupByOption, op: FilterOp, value: string, grain: string = DEFAULT_GRAIN): string {
  const ref = option.kind === 'time'
    ? `{{ TimeDimension('${option.name}', '${option.nativeGrain && option.name !== METRIC_TIME ? option.nativeGrain : grain}') }}`
    : `{{ Dimension('${option.name}') }}`;
  if (op === 'is null' || op === 'is not null') return `${ref} ${op}`;
  if (op === 'in' || op === 'not in') {
    const values = value.split(',').map((v) => v.trim()).filter(Boolean).map(literal);
    return `${ref} ${op} (${values.join(', ')})`;
  }
  return `${ref} ${op} ${literal(value)}`;
}

/** A filter for display: templates replaced by the names they reference. */
export function filterLabel(where: string): string {
  return where.replace(/\{\{\s*(?:Dimension|TimeDimension|Entity|Metric)\(\s*['"](\w+)['"][^}]*\}\}/g, '$1').trim();
}
