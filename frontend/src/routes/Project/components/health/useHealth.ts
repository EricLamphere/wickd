import { useCallback } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api';
import { useProjectEvents } from '../../../../lib/sse';

export type HealthCheckKind = 'connection' | 'drift' | 'freshness';

/** Events after which the summary (statuses, counts, staleness) may have changed. */
const SUMMARY_EVENTS = new Set([
  'health_check_started', 'health_check_finished',
  'drift_started', 'drift_finished',
  'freshness_started', 'freshness_finished',
  'statuses_changed', // rebuilt models make a drift scan stale
]);

/** Status of all three checks; shared by the overview, tab badges and the nav rail dot. */
export function useHealthSummary(projectId: number) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['health-summary', projectId],
    queryFn: () => api.health.summary(projectId),
    enabled: !!projectId,
    retry: false,
  });
  useProjectEvents(projectId, useCallback((event) => {
    if (SUMMARY_EVENTS.has(event.type)) {
      qc.invalidateQueries({ queryKey: ['health-summary', projectId] });
    }
  }, [projectId, qc]));
  return query;
}

const runKey = (kind: HealthCheckKind, projectId: number) => ['health-run', kind, projectId];

/** Start mutations for the checks. Keyed, so a run started on the overview shows as
 *  running on its tab too (and vice versa). */
export function useHealthRuns(projectId: number) {
  const qc = useQueryClient();
  const settle = (...keys: string[]) => () => {
    for (const key of [...keys, 'health-summary']) qc.invalidateQueries({ queryKey: [key, projectId] });
  };

  const connection = useMutation({
    mutationKey: runKey('connection', projectId),
    mutationFn: () => api.projects.debug(projectId),
    onSettled: settle('health-check-last'),
  });
  const drift = useMutation({
    mutationKey: runKey('drift', projectId),
    mutationFn: () => api.drift.start(projectId),
    onSettled: settle('drift-latest'),
  });
  const freshness = useMutation({
    mutationKey: runKey('freshness', projectId),
    mutationFn: () => api.freshness.start(projectId),
    onSettled: settle('freshness-latest'),
  });

  // dbt runs are serialized per project, so these queue up in this order
  const runAll = () => {
    connection.mutate();
    drift.mutate();
    freshness.mutate();
  };

  return { connection, drift, freshness, runAll };
}

/** True while a check's start request is in flight anywhere in the app. */
export function useIsStarting(kind: HealthCheckKind, projectId: number): boolean {
  return useIsMutating({ mutationKey: runKey(kind, projectId) }) > 0;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
