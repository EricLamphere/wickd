// A project's scheduled runs (plan 27), kept fresh by `run_schedules_changed`, and the
// failed runs the viewer hasn't seen yet (Runs nav dot, Schedule tab dot).
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { schedulesApi } from './schedulesApi';
import { latestEventId, loadSeen, saveSeen, SEEN_EVENT, unseenFailures } from './scheduleAlerts';
import { useProjectEvents } from './sse';

export const runSchedulesKey = (projectId: number) => ['run-schedules', projectId] as const;

export function useRunSchedules(projectId: number) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'run_schedules_changed' || event.type === 'run_history_changed') {
      qc.invalidateQueries({ queryKey: runSchedulesKey(projectId) });
    }
    if (event.type === 'run_schedules_changed') {
      qc.invalidateQueries({ queryKey: ['run-schedule-history', projectId] });
    }
  }, [projectId, qc]));
  return useQuery({
    queryKey: runSchedulesKey(projectId),
    queryFn: () => schedulesApi.list(projectId),
    enabled: Number.isFinite(projectId),
  });
}

export function useScheduleAlerts(projectId: number) {
  const { data } = useRunSchedules(projectId);
  const [seen, setSeen] = useState(() => loadSeen(projectId));
  useEffect(() => {
    setSeen(loadSeen(projectId));
    const onSeen = () => setSeen(loadSeen(projectId));
    window.addEventListener(SEEN_EVENT, onSeen);
    return () => window.removeEventListener(SEEN_EVENT, onSeen);
  }, [projectId]);
  const items = data?.items ?? [];
  const failures = unseenFailures(items, seen);
  const markAllSeen = useCallback(() => saveSeen(projectId, latestEventId(items)), [projectId, items]);
  return { failures, markAllSeen };
}
