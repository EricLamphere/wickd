// The Marked as expected log (plan 30; Pro, with monitors): ['metric-monitor-expectations', id],
// refreshed by metric_monitor_expectations_changed (mark, undo, link a note) and, for note_missing,
// metric_notes_changed.
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isProFeatureRequiredError } from '../../../../lib/api';
import { monitorsApi } from '../../../../lib/monitorsApi';
import { useProjectEvents } from '../../../../lib/sse';
import { useProEntitled } from '../../RunHistory/usePerformance';

export const expectationsKey = (projectId: number) => ['metric-monitor-expectations', projectId] as const;

export function useExpectations(projectId: number) {
  const qc = useQueryClient();
  const { entitled } = useProEntitled();
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'metric_monitor_expectations_changed' || event.type === 'metric_notes_changed') {
      qc.invalidateQueries({ queryKey: expectationsKey(projectId) });
    }
  }, [projectId, qc]));
  return useQuery({
    queryKey: expectationsKey(projectId),
    queryFn: () => monitorsApi.expectations(projectId),
    enabled: !!projectId && entitled,
    retry: (count, err) => !isProFeatureRequiredError(err) && count < 2,
    staleTime: 30_000,
  });
}
