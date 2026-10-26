import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useProjectEvents } from '../../../lib/sse';
import { buildDurationMap, type NodeDurationData } from './durationOverlay';

/** DAG "Durations" overlay: toggle (per project, sessionStorage) + median run time per node.
 *  Fetches only while on; refetched after every persisted run (statuses_changed). */
export function useDurationOverlay(projectId: number): {
  enabled: boolean;
  toggle: () => void;
  durations: Map<string, NodeDurationData> | null;
} {
  const storageKey = `dag-duration-overlay-${projectId}`;
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return sessionStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try { sessionStorage.setItem(storageKey, next ? '1' : '0'); } catch {}
      return next;
    });
  }, [storageKey]);

  const { data } = useQuery({
    queryKey: ['node-durations', projectId],
    queryFn: () => api.performance.nodeDurations(projectId),
    enabled,
  });

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'statuses_changed') qc.invalidateQueries({ queryKey: ['node-durations', projectId] });
  }, [projectId, qc]));

  const durations = useMemo(() => (enabled && data ? buildDurationMap(data.nodes) : null), [enabled, data]);
  return { enabled, toggle, durations };
}
