// Metric search everywhere a metric is searched or picked (sidebar, All metrics, dashboard rail,
// Add a metric, monitors, compare): search text (name, label, description, type, semantic model)
// plus multi-select semantic model and metric type filters.
import type { CatalogMetric, CatalogSavedQuery } from '../../../../lib/semanticApi';

export interface SidebarFilter {
  search: string;
  /** semantic models; a metric passes when it reads any of them (empty = all) */
  models: ReadonlySet<string>;
  /** metric types (empty = all) */
  types: ReadonlySet<string>;
}

export const EMPTY_SIDEBAR_FILTER: SidebarFilter = { search: '', models: new Set(), types: new Set() };

/** MetricFlow's metric types, in the order the Type filter lists them. */
const TYPE_ORDER = ['simple', 'ratio', 'cumulative', 'derived', 'conversion'];

export function modelOptions(metrics: readonly CatalogMetric[]): string[] {
  return [...new Set(metrics.flatMap((m) => m.semantic_models))].sort((a, b) => a.localeCompare(b));
}

export function typeOptions(metrics: readonly CatalogMetric[]): string[] {
  const present = new Set(metrics.map((m) => m.type));
  const known = TYPE_ORDER.filter((t) => present.has(t));
  const other = [...present].filter((t) => !TYPE_ORDER.includes(t)).sort();
  return [...known, ...other];
}

function textMatches(needle: string, ...texts: (string | null)[]): boolean {
  return !needle || texts.some((t) => (t ?? '').toLowerCase().includes(needle));
}

function passesFacets(m: CatalogMetric, f: SidebarFilter): boolean {
  const modelOk = f.models.size === 0 || m.semantic_models.some((s) => f.models.has(s));
  const typeOk = f.types.size === 0 || f.types.has(m.type);
  return modelOk && typeOk;
}

export function filterMetrics(metrics: readonly CatalogMetric[], f: SidebarFilter): CatalogMetric[] {
  const needle = f.search.trim().toLowerCase();
  return metrics.filter((m) => textMatches(needle, m.name, m.label, m.description, m.type, ...m.semantic_models) && passesFacets(m, f));
}

/** Saved queries matching the search; with a model or type filter, only those using a metric that passes it. */
export function filterSavedQueries(
  queries: readonly CatalogSavedQuery[], metrics: readonly CatalogMetric[], f: SidebarFilter,
): CatalogSavedQuery[] {
  const needle = f.search.trim().toLowerCase();
  const faceted = f.models.size > 0 || f.types.size > 0;
  const allowed = new Set(metrics.filter((m) => passesFacets(m, f)).map((m) => m.name));
  return queries.filter((q) => textMatches(needle, q.name, q.label) && (!faceted || q.metrics.some((n) => allowed.has(n))));
}
