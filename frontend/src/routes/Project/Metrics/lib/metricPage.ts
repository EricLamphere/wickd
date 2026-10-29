// Metric pages and the metric index (plan 13): the chart's queries for a period, where a metric
// comes from (lineage), where it's used, its health issues, and the index's grouping and search.
// Pure; tested in metricPage.test.ts.
import type { GraphDto, ModelNode } from '../../../../lib/api';
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

/** The batch's answers for `q` as a widget result, drawn by the dashboards' time series renderer. */
export function chartResult(q: ChartQueries, items: QueryBatchItemDto[]): WidgetResultDto {
  const query = (body: MetricQueryBody, item: QueryBatchItemDto | undefined): WidgetQueryDto => ({
    status: item?.status ?? 'not_run', query: body, sql: item?.result?.sql ?? null, columns: item?.result?.columns ?? [],
    rows: item?.result?.rows ?? [], truncated: item?.result?.truncated ?? false, ran_at: item?.result?.ran_at ?? null, error: item?.error ?? null,
  });
  const current = query(q.currentBody, items[0]);
  const queries: Record<string, WidgetQueryDto> = { current };
  if (q.previousBody) queries.current_previous = query(q.previousBody, items[1]);
  const all = Object.values(queries);
  const error = all.find((x) => x.status === 'error')?.error ?? null;
  const ran = all.map((x) => x.ran_at).filter((x): x is string => !!x).sort();
  return {
    widget_id: 'metric-page', status: error ? 'error' : all.some((x) => x.status === 'not_run') ? 'not_run' : 'ok', error, notes: [],
    grain: q.grain, current: q.current, previous: q.previous, ran_at: ran[0] ?? null, queries,
  };
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

export function searchMetrics(metrics: CatalogMetric[], query: string): CatalogMetric[] {
  const q = query.trim().toLowerCase();
  if (!q) return metrics;
  return metrics.filter((m) => [m.name, m.label ?? '', m.description ?? '', m.type, ...m.semantic_models]
    .some((t) => t.toLowerCase().includes(q)));
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
