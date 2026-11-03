// Debug tab data (plan 15). Opening the tab runs the checks (stored results first; the missing ones
// in one dbt show), Rerun reruns them all, Cancel kills the batch. Deliberately not invalidated on
// graph_changed: every dbt show rewrites manifest.json, and a refetch would run failed checks again
// (same reason as the explorer preview). A changed query is a new key.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { metricDebugApi, type DebugResultDto } from '../../../../../lib/metricDebugApi';
import type { MetricQueryBody } from '../../../../../lib/semanticApi';
import { debugQueryKey } from '../../lib/debugView';

export function debuggable(body: MetricQueryBody | null): body is MetricQueryBody {
  return !!body && !body.saved_query && !!body.metrics?.length;
}

export function useMetricDebug(projectId: number, body: MetricQueryBody | null, enabled: boolean) {
  const qc = useQueryClient();
  const key = debugQueryKey(projectId, body);
  const query = useQuery({
    queryKey: key,
    queryFn: () => metricDebugApi.debug(projectId, body!),
    enabled: enabled && debuggable(body),
    staleTime: Infinity,
    retry: false,
  });
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<unknown>(null);

  const rerun = useCallback(async () => {
    if (!debuggable(body)) return;
    setRerunning(true);
    setRerunError(null);
    try {
      const fresh = await metricDebugApi.debug(projectId, body, { refresh: true });
      qc.setQueryData<DebugResultDto>(key, fresh);
    } catch (err) {
      setRerunError(err);
    } finally {
      setRerunning(false);
    }
  }, [projectId, body, qc, key]);

  const cancel = useCallback(() => metricDebugApi.cancel(projectId).catch(() => undefined), [projectId]);

  return {
    data: query.data,
    error: rerunError ?? query.error,
    running: query.isFetching || rerunning,
    rerun,
    cancel,
  };
}

export function useReconcile(projectId: number) {
  return useMutation({
    mutationFn: ({ body, sql }: { body: MetricQueryBody; sql: string }) => metricDebugApi.reconcile(projectId, body, sql),
  });
}

export function useExplainNumber(projectId: number) {
  return useMutation({
    mutationFn: (body: MetricQueryBody) => metricDebugApi.explain(projectId, body),
  });
}
