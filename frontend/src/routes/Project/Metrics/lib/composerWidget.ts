// The query composer's chips ⇄ the query view's widget (plan 16). The widget is the only state:
// fromWidget() shows it as chips, toWidget() writes chips back — metrics, filters, period and
// comparison, and `by` / grain / `top N` into the option its type uses for them (below). Every
// other option (style, format, layout…) is left as it was. The composer changes the type only
// while the widget's type is still one it would pick itself (inferType / canInfer): it never
// overrides a type picked in Configure. Pure; unit-tested in composer.test.ts.
import type { DashboardWidget, Grain, WidgetType } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { changeType, opt, widgetInfo } from '../dashboards/dashboardModel';
import type { Chip } from './composer';
import { explorePeriod } from './exploreWidget';
import { groupByOptions } from './metricQuery';

/** Options the composer owns, per type; deleted and rewritten from the chips on every change. */
const OWNED: Record<WidgetType, string[]> = {
  summary: [],
  timeseries: ['grain', 'split_by', 'top_n'],
  bar: ['dimension', 'stack_by', 'top_n'],
  leaderboard: ['dimension', 'top_n'],
  table: ['period_grain', 'dimensions', 'limit'],
  text: [],
};
const ALL_OWNED = [...new Set(Object.values(OWNED).flat())];
const MAX_TABLE_DIMENSIONS = 5;

export interface ChipError {
  /** index into the chips */
  index: number;
  message: string;
}

export interface Composed {
  widget: DashboardWidget;
  errors: ChipError[];
}

export interface FromWidgetOptions {
  /** show the period and comparison even when the widget follows the defaults (the query view) */
  period?: boolean;
}

/** The widget as chips: metrics, by / grain, period, comparison, filters, top N. */
export function fromWidget(widget: DashboardWidget, { period = true }: FromWidgetOptions = {}): Chip[] {
  const chips: Chip[] = (widget.metrics ?? []).map((name) => ({ kind: 'metric', name }));
  const dim = (key: string) => {
    const name = opt<string | null>(widget, key, null);
    if (name) chips.push({ kind: 'dimension', name });
  };
  const grain = (key: string, fallback: Grain | null) => {
    const g = opt<Grain | null>(widget, key, fallback);
    if (g) chips.push({ kind: 'time', grain: g });
  };
  // a widget without metrics yet (a fresh query view) has no shape: the typed line picks one
  const shape = widget.metrics?.length ? widget.type : null;
  switch (shape) {
    case 'timeseries': grain('grain', 'auto'); dim('split_by'); break;
    case 'bar': dim('dimension'); dim('stack_by'); break;
    case 'leaderboard': dim('dimension'); break;
    case 'table':
      grain('period_grain', null);
      for (const name of opt<string[]>(widget, 'dimensions', [])) chips.push({ kind: 'dimension', name });
      break;
    default: break;
  }
  if (period || widget.period?.current) chips.push({ kind: 'period', value: explorePeriod(widget).current });
  if (period || widget.period?.compare) chips.push({ kind: 'compare', value: explorePeriod(widget).compare });
  for (const where of widget.filters ?? []) chips.push({ kind: 'filter', where });
  const top = widget.options?.[widget.type === 'table' ? 'limit' : 'top_n'];
  // a time series' top N only applies while it's split
  const topApplies = !!shape && shape !== 'summary' && (shape !== 'timeseries' || !!widget.options?.split_by);
  if (typeof top === 'number' && topApplies) chips.push({ kind: 'top', n: top });
  return chips;
}

/** The type the chips' shape asks for (as widgetFromQuery() picks one): over time → time series,
 *  by a dimension → bars (one dimension + top N on one metric → Top N), neither → summary. */
export function inferType(chips: Chip[]): WidgetType {
  const metrics = chips.filter((c) => c.kind === 'metric').length;
  const dims = chips.filter((c) => c.kind === 'dimension').length;
  if (chips.some((c) => c.kind === 'time')) return 'timeseries';
  if (!dims) return 'summary';
  return dims === 1 && metrics <= 1 && chips.some((c) => c.kind === 'top') ? 'leaderboard' : 'bar';
}

/** Whether the composer may pick the type: a fresh widget (no metrics yet), or one whose type is
 *  what its own chips would pick — i.e. nobody chose another one in Configure. */
export function canInfer(widget: DashboardWidget): boolean {
  if (!widget.metrics?.length) return true;
  return widget.type !== 'table' && inferType(fromWidget(widget)) === widget.type;
}

interface Pieces {
  metrics: { name: string; index: number }[];
  dims: { name: string; index: number }[];
  time: { grain: Grain; index: number } | null;
  top: { n: number; index: number } | null;
  filters: string[];
  period: Extract<Chip, { kind: 'period' }> | null;
  compare: Extract<Chip, { kind: 'compare' }> | null;
}

function pieces(chips: Chip[], errors: ChipError[]): Pieces {
  const p: Pieces = { metrics: [], dims: [], time: null, top: null, filters: [], period: null, compare: null };
  chips.forEach((c, index) => {
    switch (c.kind) {
      case 'metric': if (!p.metrics.some((m) => m.name === c.name)) p.metrics.push({ name: c.name, index }); break;
      case 'dimension': if (!p.dims.some((d) => d.name === c.name)) p.dims.push({ name: c.name, index }); break;
      // the last one typed wins
      case 'time': p.time = { grain: c.grain, index }; break;
      case 'top': p.top = { n: c.n, index }; break;
      case 'filter': p.filters.push(c.where); break;
      case 'period': p.period = c; break;
      case 'compare': p.compare = c; break;
      case 'draft': errors.push({ index, message: c.error }); break;
    }
  });
  return p;
}

const TYPE_NAME: Record<WidgetType, string> = {
  summary: 'A summary', timeseries: 'A time series', bar: 'A bar chart', leaderboard: 'A Top N', table: 'A table', text: 'A text widget',
};
const CHANGE = 'change the type in Configure';

/** The type's options for the chips (`out`), or errors for chips the type can't hold. */
function typeOptions(type: WidgetType, p: Pieces, out: Record<string, unknown>, errors: ChipError[]) {
  const name = TYPE_NAME[type];
  const tooMany = (max: number, what: string) => p.dims.slice(max).forEach((d) => errors.push({ index: d.index, message: `${name} ${what}; ${CHANGE}` }));
  const noTime = () => { if (p.time) errors.push({ index: p.time.index, message: `${name} isn't over time; ${CHANGE}` }); };
  switch (type) {
    case 'summary':
      noTime();
      tooMany(0, 'shows totals, not a breakdown');
      if (p.top) errors.push({ index: p.top.index, message: `${name} has no top N; ${CHANGE}` });
      return;
    case 'timeseries':
      if (p.time && p.time.grain !== 'auto') out.grain = p.time.grain;
      if (p.dims[0]) out.split_by = p.dims[0].name;
      tooMany(1, 'splits by one dimension');
      if (p.top && !p.dims[0]) errors.push({ index: p.top.index, message: 'top N needs a "by" to split the lines' });
      else if (p.top) out.top_n = Math.min(p.top.n, 20);
      return;
    case 'bar':
      noTime();
      if (p.dims[0]) out.dimension = p.dims[0].name;
      if (p.dims[1]) out.stack_by = p.dims[1].name;
      tooMany(2, 'has bars by one dimension and stacks by another');
      if (p.top) out.top_n = Math.min(p.top.n, 50);
      return;
    case 'leaderboard':
      noTime();
      if (p.dims[0]) out.dimension = p.dims[0].name;
      tooMany(1, 'ranks one dimension');
      if (p.top) out.top_n = Math.min(p.top.n, 50);
      return;
    case 'table':
      if (p.time) out.period_grain = p.time.grain;
      if (p.dims.length) out.dimensions = p.dims.slice(0, MAX_TABLE_DIMENSIONS).map((d) => d.name);
      tooMany(MAX_TABLE_DIMENSIONS, `has rows by up to ${MAX_TABLE_DIMENSIONS} dimensions`);
      if (p.top) out.limit = p.top.n;
      return;
    default:
      return;
  }
}

/**
 * `base` with the chips applied. `infer` lets the chips pick the type (canInfer). Errors point at
 * the chips that can't apply (drafts, a dimension the metrics don't share, a `by` the type can't
 * hold); the widget is still returned, but the composer only commits a line without errors.
 */
export function toWidget(chips: Chip[], base: DashboardWidget, catalog: SemanticCatalogDto, { infer = false } = {}): Composed {
  const errors: ChipError[] = [];
  const p = pieces(chips, errors);
  const metrics = p.metrics.map((m) => m.name);
  const type = infer && metrics.length ? inferType(chips) : base.type;
  const typed = type === base.type ? base : changeType(base, type, catalog);

  const shared = new Set(groupByOptions(catalog, metrics).filter((o) => o.kind === 'categorical').map((o) => o.name));
  for (const d of p.dims) {
    if (metrics.length && !shared.has(d.name)) {
      errors.push({ index: d.index, message: `${metrics.length > 1 ? 'These metrics' : metrics[0]} can't be broken down by ${d.name}` });
    }
  }
  const max = widgetInfo(type).maxMetrics;
  p.metrics.slice(max).forEach((m) => errors.push({ index: m.index, message: `${TYPE_NAME[type]} shows up to ${max} metric${max === 1 ? '' : 's'}` }));

  const options: Record<string, unknown> = { ...(typed.options ?? {}) };
  for (const key of ALL_OWNED) delete options[key];
  typeOptions(type, p, options, errors);

  const shown = explorePeriod(base);
  const period = { ...(base.period ?? {}) };
  if (p.period && JSON.stringify(p.period.value) !== JSON.stringify(shown.current)) period.current = p.period.value;
  if (p.compare && JSON.stringify(p.compare.value) !== JSON.stringify(shown.compare)) period.compare = p.compare.value;

  const widget: DashboardWidget = { ...typed, type, metrics: metrics.slice(0, max) };
  widget.filters = p.filters.length ? p.filters : undefined;
  widget.options = Object.keys(options).length || base.options ? options : undefined;
  widget.period = Object.keys(period).length ? period : undefined;
  return { widget: clean(widget), errors: errors.sort((a, b) => a.index - b.index) };
}

/** Without undefined keys (so equal widgets compare equal). */
function clean(widget: DashboardWidget): DashboardWidget {
  return Object.fromEntries(Object.entries(widget).filter(([, v]) => v !== undefined)) as DashboardWidget;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Same widget, ignoring key order, undefined keys and an empty options object. */
export function sameWidget(a: DashboardWidget, b: DashboardWidget): boolean {
  const norm = (w: DashboardWidget) => canonical({ ...w, options: w.options && Object.keys(w.options).length ? w.options : undefined });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
