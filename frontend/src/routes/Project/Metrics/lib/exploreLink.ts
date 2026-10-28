// "Explore" links into the Metrics page from the SidePane, Docs and the command palette.
// Pure; unit-tested in exploreLink.test.ts.
import type { MetricQueryBody } from '../../../../lib/semanticApi';
import { DEFAULT_GRAIN, EMPTY_STATE, METRIC_TIME, writeState } from './metricQuery';

export const EXPLORABLE_TYPES = new Set(['metric', 'semantic_model', 'saved_query']);

/** The Metrics page search string for a node (null when there's nothing to explore). */
export function exploreSearch(
  resourceType: string,
  name: string,
  opts: { grain?: string | null; modelMetrics?: string[] } = {},
): string | null {
  const grain = opts.grain || DEFAULT_GRAIN;
  if (resourceType === 'saved_query') return writeState(new URLSearchParams(), { ...EMPTY_STATE, savedQuery: name }).toString();
  const metrics = resourceType === 'metric' ? [name] : resourceType === 'semantic_model' ? opts.modelMetrics ?? [] : [];
  if (!metrics.length) return null;
  return writeState(new URLSearchParams(), { ...EMPTY_STATE, metrics, groupBy: [METRIC_TIME], grain }).toString();
}

export function exploreUrl(projectId: number, search: string): string {
  return `/projects/${projectId}/metrics?${search}`;
}

/** The request "Explore" opens for one metric — so its stored result can preview it (Docs sparkline). */
export function previewBody(metric: string, grain?: string | null): MetricQueryBody {
  const column = `${METRIC_TIME}__${grain || DEFAULT_GRAIN}`;
  return { metrics: [metric], group_by: [column], order_by: [`-${column}`] };
}
