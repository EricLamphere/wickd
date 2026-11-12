// Metric pages and the metric index (plan 13): the chart's queries for a period, where a metric
// comes from (lineage), where it's used, its health issues, and the index's grouping and search.
// Pure; tested in metricPage.test.ts.
import type { GraphDto, ModelNode, SemanticInfo } from '../../../../lib/api';
import type { ComparePeriod, CurrentPeriod, DashboardSummaryDto, DateRange, WidgetQueryDto, WidgetResultDto } from '../../../../lib/dashboardsApi';
import type {
  CatalogMetric, CatalogSavedQuery, MetricQueryBody, QueryBatchItemDto, SemanticCatalogDto, SemanticIssue,
} from '../../../../lib/semanticApi';
import { resolveCompare, resolveCurrent } from '../dashboards/periods';
import { METRIC_TIME } from './metricQuery';

export interface MetricPeriod {
  current: CurrentPeriod;
  compare: ComparePeriod;
}

export const DEFAULT_PERIOD: MetricPeriod = { current: 'last_30_days', compare: 'previous_period' };

/** The time grain for a range (dashboard_periods.auto_grain on the backend). */
export function autoGrain(range: DateRange | null): string {
  if (!range) return 'month';
  const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
  if (days <= 31) return 'day';
  if (days <= 180) return 'week';
  if (days <= 3 * 366) return 'month';
  return 'quarter';
}

export interface ChartQueries {
  grain: string;
  current: DateRange | null;
  previous: DateRange | null;
  /** the metric over time in the current period */
  currentBody: MetricQueryBody;
  /** the same over the comparison period (null when not comparing) */
  previousBody: MetricQueryBody | null;
}

function overTime(metric: string, column: string, range: DateRange | null): MetricQueryBody {
  return { metrics: [metric], group_by: [column], order_by: [column], ...(range ? { start: range.start, end: range.end } : {}) };
}

/** A metric's chart queries for `period` (the metric index's sparklines are the current one). */
export function chartQueries(metric: string, period: MetricPeriod, today: Date = new Date()): ChartQueries {
  const current = resolveCurrent(period.current, today);
  const previous = resolveCompare(period.compare, current);
  const grain = autoGrain(current);
  const column = `${METRIC_TIME}__${grain}`;
  return { grain, current, previous, currentBody: overTime(metric, column, current), previousBody: previous ? overTime(metric, column, previous) : null };
}

/** How many values the page's "By dimension" chart shows. */
export const BREAKDOWN_TOP_N = 10;

/** A role on the metric page, each one query of its batch. */
export type PageRole = 'current' | 'current_previous' | 'total' | 'total_previous' | 'by_dimension' | 'by_dimension_previous';

export interface PageQueries extends ChartQueries {
  /** the breakdown's dimension (null: the metric has none, so no breakdown) */
  dimension: string | null;
  /** the batch: each role's query, in order */
  roles: [PageRole, MetricQueryBody][];
}

function ranged(body: MetricQueryBody, range: DateRange | null): MetricQueryBody {
  return range ? { ...body, start: range.start, end: range.end } : body;
}

/**
 * The metric page's queries: over time (the chart), the period's total (its own query, never
 * the sum of the trend), and the top values of `dimension` — each with its comparison period.
 * The roles mirror the dashboards' planner (dashboard_plan.py) so their renderers draw them.
 */
export function pageQueries(metric: string, period: MetricPeriod, dimension: string | null, today: Date = new Date()): PageQueries {
  const chart = chartQueries(metric, period, today);
  const { current, previous } = chart;
  const roles: [PageRole, MetricQueryBody][] = [['current', chart.currentBody]];
  if (chart.previousBody) roles.push(['current_previous', chart.previousBody]);
  roles.push(['total', ranged({ metrics: [metric] }, current)]);
  if (previous) roles.push(['total_previous', ranged({ metrics: [metric] }, previous)]);
  if (dimension) {
    const by: MetricQueryBody = { metrics: [metric], group_by: [dimension], order_by: [`-${metric}`] };
    roles.push(['by_dimension', ranged({ ...by, limit: BREAKDOWN_TOP_N }, current)]);
    if (previous) roles.push(['by_dimension_previous', ranged(by, previous)]);
  }
  return { ...chart, dimension, roles };
}

/** Which page role fills each of a dashboard widget's roles. */
export const WIDGET_ROLES = {
  summary: { total: 'total', total_previous: 'total_previous', trend: 'current', trend_previous: 'current_previous' },
  timeseries: { current: 'current', current_previous: 'current_previous' },
  bar: { current: 'by_dimension', current_previous: 'by_dimension_previous' },
} as const satisfies Record<string, Record<string, PageRole>>;

/** The batch's answers as one widget's result (`roles`: widget role → page role), for its renderer. */
export function pageResult(q: PageQueries, items: QueryBatchItemDto[], roles: Record<string, PageRole>): WidgetResultDto {
  const byRole = new Map(q.roles.map(([role, body], i) => [role, { body, item: items[i] }]));
  const queries: Record<string, WidgetQueryDto> = {};
  for (const [widgetRole, pageRole] of Object.entries(roles)) {
    const found = byRole.get(pageRole);
    if (!found) continue;
    const { body, item } = found;
    queries[widgetRole] = {
      status: item?.status ?? 'not_run', query: body, sql: item?.result?.sql ?? item?.sql ?? null, columns: item?.result?.columns ?? [],
      rows: item?.result?.rows ?? [], truncated: item?.result?.truncated ?? false, ran_at: item?.result?.ran_at ?? null, error: item?.error ?? null,
    };
  }
  const all = Object.values(queries);
  const error = all.find((x) => x.status === 'error')?.error ?? null;
  const ran = all.map((x) => x.ran_at).filter((x): x is string => !!x).sort();
  return {
    widget_id: 'metric-page', status: error ? 'error' : all.some((x) => x.status === 'running') ? 'running'
      : all.some((x) => x.status === 'not_run') ? 'not_run' : 'ok', error, notes: [],
    grain: q.grain, current: q.current, previous: q.previous, ran_at: ran[0] ?? null, queries,
  };
}

/** A metric filter as people read it: `{{ Dimension('order__status') }} = 'x'` → `order__status = 'x'`. */
export function readableFilter(filter: string): string {
  return filter
    .replace(/\{\{\s*(?:Dimension|Entity|TimeDimension)\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?\s*\)(?:\.grain\(\s*'([^']+)'\s*\))?\s*\}\}/g,
      (_m, name: string, grain?: string, grain2?: string) => (grain ?? grain2 ? `${name} (${grain ?? grain2})` : name))
    .replace(/\s+/g, ' ')
    .trim();
}

const AGG_LABELS: Record<string, string> = {
  sum: 'Sum', count: 'Count', count_distinct: 'Distinct count', average: 'Average', avg: 'Average', min: 'Minimum',
  max: 'Maximum', median: 'Median', percentile: 'Percentile', sum_boolean: 'Count of true',
};

/** One step of how a metric is calculated, in words: `text` with `code` parts (names, expressions). */
export type CalcPart = { text: string } | { code: string };

/** How a metric is calculated, as a sentence (the metric page's "How it's calculated"). */
export function calculationParts(s: SemanticInfo): CalcPart[] {
  const type = s.type ?? '';
  if (type === 'simple') {
    if (s.agg) {
      const agg = AGG_LABELS[s.agg] ?? s.agg;
      return s.expr ? [{ text: `${agg} of ` }, { code: s.expr }] : [{ text: agg }];
    }
    return s.measure ? [{ text: 'The measure ' }, { code: s.measure }] : [];
  }
  if (type === 'ratio' && s.numerator && s.denominator) {
    return [{ code: s.numerator }, { text: ' divided by ' }, { code: s.denominator }];
  }
  if (type === 'derived' && s.expr) return [{ code: s.expr }];
  if (type === 'cumulative') {
    const input = s.measure ?? s.input_metrics?.[0];
    if (!input) return [{ text: 'A running total' }];
    const tail = s.window ? ` over a ${s.window} window` : s.grain_to_date ? `, ${s.grain_to_date} to date` : ' over all time';
    return [{ text: 'Running total of ' }, { code: input }, { text: tail }];
  }
  if (type === 'conversion') return [{ text: 'Conversion rate between two events' }];
  return [];
}

// ── lineage ──────────────────────────────────────────────────────────────────

export interface MetricLineage {
  /** metrics this one is computed from (derived, ratio, cumulative over a metric) */
  inputMetrics: ModelNode[];
  semanticModels: ModelNode[];
  /** the dbt models the semantic models are defined on */
  models: ModelNode[];
  /** those models' own parents */
  upstream: ModelNode[];
}

function parentsOf(graph: GraphDto, uids: string[], types: readonly string[]): ModelNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.unique_id, n]));
  const wanted = new Set(uids);
  const out = new Map<string, ModelNode>();
  for (const { source, target } of graph.edges) {
    if (!wanted.has(target)) continue;
    const n = byId.get(source);
    if (n && types.includes(n.resource_type)) out.set(n.unique_id, n);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Where a metric comes from; an input metric's own semantic models count too (a ratio's). */
export function metricLineage(graph: GraphDto, metricUid: string): MetricLineage {
  const inputMetrics = parentsOf(graph, [metricUid], ['metric']);
  // follow input metrics down to the semantic models (derived of derived), guarding cycles
  const seen = new Set([metricUid]);
  let frontier = [metricUid];
  const metricIds: string[] = [];
  while (frontier.length) {
    metricIds.push(...frontier);
    frontier = parentsOf(graph, frontier, ['metric']).map((n) => n.unique_id).filter((uid) => !seen.has(uid));
    frontier.forEach((uid) => seen.add(uid));
  }
  const semanticModels = parentsOf(graph, metricIds, ['semantic_model']);
  const models = parentsOf(graph, semanticModels.map((n) => n.unique_id), ['model', 'seed', 'snapshot']);
  const modelIds = new Set(models.map((n) => n.unique_id));
  const upstream = parentsOf(graph, [...modelIds], ['model', 'seed', 'snapshot', 'source']).filter((n) => !modelIds.has(n.unique_id));
  return { inputMetrics, semanticModels, models, upstream };
}

// ── usage ────────────────────────────────────────────────────────────────────

export interface MetricUsage {
  savedQueries: CatalogSavedQuery[];
  exposures: ModelNode[];
  dashboards: DashboardSummaryDto[];
  /** metrics built on this one */
  usedByMetrics: ModelNode[];
}

export function metricUsage(metric: string, metricUid: string | null, graph: GraphDto | null | undefined,
  catalog: SemanticCatalogDto, dashboards: DashboardSummaryDto[]): MetricUsage {
  const children = (types: string[]) => {
    if (!graph || !metricUid) return [];
    const byId = new Map(graph.nodes.map((n) => [n.unique_id, n]));
    const out = new Map<string, ModelNode>();
    for (const { source, target } of graph.edges) {
      const n = source === metricUid ? byId.get(target) : undefined;
      if (n && types.includes(n.resource_type)) out.set(n.unique_id, n);
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    savedQueries: catalog.saved_queries.filter((q) => q.metrics.includes(metric)),
    exposures: children(['exposure']),
    dashboards: dashboards.filter((d) => !d.error && (d.metrics ?? []).includes(metric)),
    usedByMetrics: children(['metric']),
  };
}

export function usageCount(u: MetricUsage): number {
  return u.savedQueries.length + u.exposures.length + u.dashboards.length + u.usedByMetrics.length;
}

// ── health ───────────────────────────────────────────────────────────────────

/** Semantic check issues about the metric itself or a semantic model it reads. */
export function metricIssues(issues: SemanticIssue[], metric: string, semanticModels: string[]): SemanticIssue[] {
  return issues.filter((i) => (i.object_type === 'metric' && i.object_name === metric)
    || (i.object_type === 'semantic_model' && i.object_name !== null && semanticModels.includes(i.object_name)));
}

// ── the index ────────────────────────────────────────────────────────────────

/** Where a metric sits in the index: its semantic model, else "Across models" (ratios, derived). */
export function metricGroup(m: CatalogMetric): string {
  if (m.semantic_models.length === 1) return m.semantic_models[0];
  return m.semantic_models.length ? 'Across models' : 'Other';
}

/** Metrics grouped for the index, groups and metrics by name ("Across models" / "Other" last). */
export function groupMetrics(metrics: CatalogMetric[]): [string, CatalogMetric[]][] {
  const groups = new Map<string, CatalogMetric[]>();
  for (const m of metrics) groups.set(metricGroup(m), [...(groups.get(metricGroup(m)) ?? []), m]);
  const last = (g: string) => (g === 'Across models' ? 1 : g === 'Other' ? 2 : 0);
  return [...groups.entries()]
    .sort(([a], [b]) => last(a) - last(b) || a.localeCompare(b))
    .map(([g, list]) => [g, [...list].sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name))]);
}

/** A metric's dimensions grouped by entity (`customer__region` under customer); time ones apart. */
export function dimensionGroups(m: CatalogMetric): { entity: string; names: string[] }[] {
  const groups = new Map<string, Set<string>>();
  for (const d of m.dimensions) {
    const base = d.type === 'time' && d.time_granularity && d.name.endsWith(`__${d.time_granularity}`)
      ? d.name.slice(0, -(d.time_granularity.length + 2)) : d.name;
    const entity = d.type === 'time' ? 'time' : base.includes('__') ? base.split('__')[0] : '(no entity)';
    groups.set(entity, (groups.get(entity) ?? new Set()).add(base));
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(a === 'time') - Number(b === 'time') || a.localeCompare(b))
    .map(([entity, names]) => ({ entity, names: [...names].sort() }));
}

/** The URL search for a metric's page on the Metrics page (Explore tab). */
export function metricPageSearch(metric: string): string {
  return new URLSearchParams({ tab: 'explore', metric }).toString();
}
