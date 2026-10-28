import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api';
import { semanticApi, type MetricflowEnvEvent } from '../../../../lib/semanticApi';
import { useGlobalEvents, useProjectEvents } from '../../../../lib/sse';

/** Project events after which MetricFlow's status may differ (new manifest, finished check). */
const STATUS_EVENTS = new Set(['graph_changed', 'semantic_check_finished']);
const CHECK_EVENTS = new Set(['semantic_check_started', 'semantic_check_finished']);

/** ['semantic-status', id, wantCli]: whether MetricFlow can run here, and why not. */
export function useSemanticStatus(projectId: number, wantCli = false) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['semantic-status', projectId, wantCli],
    queryFn: () => semanticApi.status(projectId, wantCli),
    enabled: !!projectId,
    retry: false,
  });
  useProjectEvents(projectId, useCallback((event) => {
    if (STATUS_EVENTS.has(event.type)) qc.invalidateQueries({ queryKey: ['semantic-status', projectId] });
  }, [projectId, qc]));
  return query;
}

/** ['semantic-check-latest', id]: the latest Health → Semantic layer run. */
export function useSemanticCheck(projectId: number) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['semantic-check-latest', projectId],
    queryFn: () => semanticApi.latestCheck(projectId),
    enabled: !!projectId,
  });
  useProjectEvents(projectId, useCallback((event) => {
    if (CHECK_EVENTS.has(event.type)) qc.invalidateQueries({ queryKey: ['semantic-check-latest', projectId] });
  }, [projectId, qc]));
  return query;
}

/** The MetricFlow sidecar's setup progress (first use builds its environment). */
export function useSidecarProgress(): MetricflowEnvEvent | null {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<MetricflowEnvEvent | null>(null);
  useGlobalEvents(useCallback((event) => {
    if (event.type !== 'metricflow_env') return;
    const data = event.data as MetricflowEnvEvent;
    setProgress(data.state === 'installing' ? data : null);
    if (data.state !== 'installing') qc.invalidateQueries({ queryKey: ['semantic-status'] });
  }, [qc]));
  return progress;
}

/** Set this project's MetricFlow mode ('' = use the global default). */
export function useSetMetricflowMode(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: '' | 'auto' | 'off') => api.projects.updateSettings(projectId, { metricflow_mode: mode }),
    onSettled: () => {
      for (const key of ['semantic-status', 'project', 'health-summary']) {
        qc.invalidateQueries({ queryKey: [key, projectId] });
      }
    },
  });
}
