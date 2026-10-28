// Data for the Metrics page: catalog, live SQL (explain), the stored/last result, Run.
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { semanticApi, type MetricQueryBody, type MetricQueryResultDto } from '../../../lib/semanticApi';
import { useProjectEvents } from '../../../lib/sse';

const EXPLAIN_DEBOUNCE_MS = 250;

/** ['semantic-catalog', id]: metrics, their group-bys and saved queries; refetched after a parse. */
export function useSemanticCatalog(projectId: number, enabled: boolean) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'graph_changed') qc.invalidateQueries({ queryKey: ['semantic-catalog', projectId] });
  }, [projectId, qc]));
  return useQuery({
    queryKey: ['semantic-catalog', projectId],
    queryFn: () => semanticApi.catalog(projectId),
    enabled: enabled && !!projectId,
    retry: false,
    staleTime: 60_000,
  });
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** ['semantic-explain', id, body]: MetricFlow's SQL as the query is edited (no warehouse). */
export function useExplain(projectId: number, body: MetricQueryBody | null) {
  const key = useDebounced(body ? JSON.stringify(body) : null, EXPLAIN_DEBOUNCE_MS);
  return useQuery({
    queryKey: ['semantic-explain', projectId, key],
    queryFn: () => semanticApi.explain(projectId, JSON.parse(key as string) as MetricQueryBody),
    enabled: !!key,
    retry: false,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

/**
 * ['metric-result', id, body]: the result shown for `body` — the stored one from the
 * cache until Run replaces it. `definitionsChanged` turns on when a parse lands after it.
 */
export function useMetricResult(projectId: number, body: MetricQueryBody | null) {
  const qc = useQueryClient();
  const key = body ? JSON.stringify(body) : null;
  const queryKey = ['metric-result', projectId, key];
  const [changedAfter, setChangedAfter] = useState<number | null>(null);

  const result = useQuery({
    queryKey,
    queryFn: () => semanticApi.cachedQuery(projectId, body as MetricQueryBody),
    enabled: !!key,
    retry: false,
    // Refetched on remount/focus: the server's stored result follows a target or profile switch
    staleTime: 0,
  });

  const run = useMutation({
    mutationFn: (b: MetricQueryBody) => semanticApi.query(projectId, { ...b, cache: 'refresh' }),
    onSuccess: (data: MetricQueryResultDto, b) => {
      qc.setQueryData(['metric-result', projectId, JSON.stringify(b)], data);
      setChangedAfter(null);
    },
  });

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'graph_changed') setChangedAfter(Date.now());
  }, []));

  // `other`: run a query that isn't on screen yet (a saved query clicked in the sidebar)
  const runNow = useCallback((other?: MetricQueryBody) => {
    const target = other ?? body;
    if (target) run.mutate(target);
  }, [body, run]);
  const cancel = useCallback(() => { api.runHistory.cancel(projectId).catch(() => {}); }, [projectId]);
  const data = result.data ?? null;
  const definitionsChanged = !!data && changedAfter !== null && changedAfter > new Date(data.ran_at).getTime();
  const isCurrentRun = run.isPending && JSON.stringify(run.variables) === key;
  return { result: data, loading: result.isLoading, run: runNow, running: isCurrentRun, runError: run.error, cancel, definitionsChanged, resetError: run.reset };
}

/** ['dbt-target', id]: the active target, shown on the Run button (shared with the Header). */
export function useActiveTarget(projectId: number) {
  return useQuery({
    queryKey: ['dbt-target', projectId],
    queryFn: () => api.profiles.getDbtTarget(projectId),
    enabled: !!projectId,
    refetchInterval: false,
  });
}
