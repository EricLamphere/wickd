// Data for the metric index and metric pages (plan 13). Both read stored results through
// POST /semantic/query/batch; a metric page then runs whatever's missing by itself (the index
// never runs on open: Run all). Run sends the same queries with `run`: they answer `running` at
// once and run in the background (backend semantic/query_runs.py) until metric_queries_finished.
// Keys: ['metric-chart', id, …] (a page's charts) and ['metric-index', id, …] (sparklines), both
// invalidated on graph_changed (new definitions → new SQL) and metric_queries_finished. The chart period is remembered per
// project in localStorage.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api';
import { semanticApi, type MetricQueryBody, type QueryBatchItemDto, type SemanticIssue } from '../../../../lib/semanticApi';
import { useProjectEvents } from '../../../../lib/sse';
import { useSemanticCheck } from '../../components/semantic/useSemantic';
import { useDashboardList } from '../dashboards/useDashboards';
import { useMonitorStatuses } from '../monitors/useMonitors';
import { chartQueries, DEFAULT_PERIOD, pageQueries, type MetricPeriod } from '../lib/metricPage';

/** The batch endpoint takes at most this many queries per request. */
const BATCH_LIMIT = 200;

const periodKey = (projectId: number) => `wickd:metric-page-period:${projectId}`;

function readPeriod(projectId: number): MetricPeriod {
  try {
    const raw = localStorage.getItem(periodKey(projectId));
    if (!raw) return DEFAULT_PERIOD;
    const parsed = JSON.parse(raw) as Partial<MetricPeriod>;
    return { current: parsed.current ?? DEFAULT_PERIOD.current, compare: parsed.compare ?? DEFAULT_PERIOD.compare };
  } catch {
    return DEFAULT_PERIOD;
  }
}

/** The metric pages' chart period (and the index's sparklines), remembered per project. */
export function useMetricPeriod(projectId: number): [MetricPeriod, (next: MetricPeriod) => void] {
  const [period, setPeriod] = useState(() => readPeriod(projectId));
  const update = useCallback((next: MetricPeriod) => {
    setPeriod(next);
    try { localStorage.setItem(periodKey(projectId), JSON.stringify(next)); } catch { /* private mode: just this visit */ }
  }, [projectId]);
  return [period, update];
}

function useInvalidateOnDefinitions(projectId: number) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event) => {
    // new definitions → new SQL; a background run finished → its results (or failures) are in
    if (event.type === 'graph_changed' || event.type === 'metric_queries_finished') {
      qc.invalidateQueries({ queryKey: ['metric-chart', projectId] });
      qc.invalidateQueries({ queryKey: ['metric-index', projectId] });
    }
  }, [projectId, qc]));
}

async function batch(projectId: number, queries: MetricQueryBody[], run: boolean): Promise<QueryBatchItemDto[]> {
  const out: QueryBatchItemDto[] = [];
  for (let i = 0; i < queries.length; i += BATCH_LIMIT) {
    out.push(...(await semanticApi.queryBatch(projectId, queries.slice(i, i + BATCH_LIMIT), run)).results);
  }
  return out;
}

/**
 * Stored results for `queries` under `key`, and run() to run the missing ones (one dbt show).
 * With `autoRun`, the missing ones run by themselves once the stored results are in — at most
 * once per set of queries per visit: a failed query is never stored, and every run rewrites
 * manifest.json (graph_changed → refetch), so retrying on every refetch would loop.
 */
function useBatch(projectId: number, key: string, queries: MetricQueryBody[], enabled: boolean, autoRun = false) {
  useInvalidateOnDefinitions(projectId);
  const qc = useQueryClient();
  const queryKey = useMemo(() => [key, projectId, JSON.stringify(queries)], [key, projectId, queries]);
  const stored = useQuery({ queryKey, queryFn: () => batch(projectId, queries, false), enabled: enabled && queries.length > 0, retry: false });
  const runner = useMutation({
    // the key and queries travel with the run, so a run that finishes after the period or
    // dimension changed lands on its own key, not the new one
    mutationFn: (v: { key: readonly unknown[]; queries: MetricQueryBody[] }) => batch(projectId, v.queries, true),
    // the run's dbt show rewrites manifest.json → graph_changed → a refetch that may have read the
    // cache before this run stored its results; drop it so it can't overwrite them with not_run
    onSuccess: async (items, v) => {
      await qc.cancelQueries({ queryKey: v.key });
      qc.setQueryData(v.key, items);
    },
  });
  const { mutate } = runner;
  const run = useCallback(() => mutate({ key: queryKey, queries }), [mutate, queryKey, queries]);

  const attempted = useRef(new Set<string>());
  const keyText = queryKey[2] as string;
  const missing = !!stored.data?.some((item) => item.status === 'not_run');
  useEffect(() => {
    if (!autoRun || !missing || runner.isPending || attempted.current.has(keyText)) return;
    attempted.current.add(keyText);
    run();
  }, [autoRun, missing, keyText, runner.isPending, run]);

  // Run answers at once; the queries run in the background until metric_queries_finished
  const inBackground = !!stored.data?.some((item) => item.status === 'running');
  return { stored, run, running: runner.isPending || inBackground, runError: runner.error };
}

/** A metric page's charts (over time, the total, the top values of `dimension`), each with its comparison. */
export function useMetricPageData(projectId: number, metric: string, period: MetricPeriod, dimension: string | null) {
  const queries = useMemo(() => pageQueries(metric, period, dimension), [metric, period, dimension]);
  const bodies = useMemo(() => queries.roles.map(([, body]) => body), [queries]);
  return { queries, ...useBatch(projectId, 'metric-chart', bodies, true, true) };
}

/** The index's sparklines: each metric's current-period chart query (the same one its page runs). */
export function useMetricSparklines(projectId: number, metrics: string[], period: MetricPeriod) {
  const bodies = useMemo(() => metrics.map((m) => chartQueries(m, period).currentBody), [metrics, period]);
  const batchState = useBatch(projectId, 'metric-index', bodies, true);
  const byMetric = useMemo(() => {
    const out = new Map<string, QueryBatchItemDto>();
    batchState.stored.data?.forEach((item, i) => out.set(metrics[i], item));
    return out;
  }, [batchState.stored.data, metrics]);
  return { ...batchState, byMetric };
}

/** What the index and pages show besides results: the graph (lineage, exposures), dashboards,
 *  the latest semantic check's issues and monitor statuses (Pro; empty without it). */
export function useMetricContext(projectId: number) {
  const graph = useQuery({ queryKey: ['graph', projectId], queryFn: () => api.models.graph(projectId) });
  const dashboards = useDashboardList(projectId);
  const check = useSemanticCheck(projectId);
  const monitors = useMonitorStatuses(projectId);
  const issues = useMemo<SemanticIssue[]>(() => {
    const r = check.data?.results;
    return r ? [...(r.errors ?? []), ...(r.warnings ?? []), ...(r.future_errors ?? [])] : [];
  }, [check.data]);
  const metricUids = useMemo(() => {
    const out = new Map<string, string>();
    for (const n of graph.data?.nodes ?? []) if (n.resource_type === 'metric') out.set(n.name, n.unique_id);
    return out;
  }, [graph.data]);
  // when the shown issues are from (null: never checked, or still running)
  const checkedAt = check.data?.status === 'done' ? check.data.finished_at : null;
  return { graph: graph.data ?? null, dashboards: dashboards.data?.dashboards ?? [], issues, monitors, metricUids, checkedAt };
}
