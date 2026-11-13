// Metric query runs in flight for a project, with progress and Cancel (backend
// semantic/query_control.py). ['metric-query-activity', id] is read once from
// GET …/semantic/queries/active, then kept current by `metric_queries_progress` events.
import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { semanticApi, type MetricQueryRunDto } from '../../../lib/semanticApi';
import { useProjectEvents } from '../../../lib/sse';
import { applyProgress, isRunEvent, summarize, type ActivitySummary, type RunKind } from './lib/queryActivity';

const activityKey = (projectId: number) => ['metric-query-activity', projectId] as const;

export function useMetricQueryActivity(projectId: number, kinds?: readonly RunKind[]) {
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: activityKey(projectId),
    queryFn: async () => (await semanticApi.activeQueries(projectId)).runs,
    staleTime: Infinity, // events keep it current
  });
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type !== 'metric_queries_progress' || !isRunEvent(event.data)) return;
    const data = event.data;
    qc.setQueryData<MetricQueryRunDto[]>(activityKey(projectId), (prev) => applyProgress(prev ?? [], data));
  }, [projectId, qc]));

  const kindsKey = kinds?.join(',') ?? '';
  // eslint-disable-next-line react-hooks/exhaustive-deps -- kindsKey stands for `kinds`
  const summary: ActivitySummary | null = useMemo(() => summarize(runs.data ?? [], kinds), [runs.data, kindsKey]);

  const cancel = useMutation({
    // with kinds, only those runs; without, every metric run (incl. the Debug tab's checks)
    mutationFn: () => semanticApi.cancelQueries(projectId, kinds ? summary?.runIds : undefined),
    onSuccess: () => qc.setQueryData<MetricQueryRunDto[]>(activityKey(projectId), (prev) =>
      (prev ?? []).map((r) => (!kinds || summary?.runIds.includes(r.run_id) ? { ...r, cancelled: true } : r))),
  });
  return { summary, cancel: cancel.mutate, cancelError: cancel.error, cancelPending: cancel.isPending };
}
