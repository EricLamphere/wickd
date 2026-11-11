import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { activityApi, type ActivitySnapshotDto } from '../../../../lib/activityApi';
import { useProjectEvents } from '../../../../lib/sse';
import {
  EMPTY_ACTIVITY,
  type ActivityState,
  dismissFinished,
  reduceActivity,
  seedActivity,
} from '../../lib/activity';

/**
 * The project's activities for the running-status bubble: reduced from project events, and
 * seeded once from GET /activity so a run started before this page opened still shows.
 * The reducer owns the state after seeding, so events never refetch the snapshot.
 */
export function useActivity(projectId: number): { state: ActivityState; dismiss: () => void } {
  const [state, setState] = useState<ActivityState>(EMPTY_ACTIVITY);

  useEffect(() => setState(EMPTY_ACTIVITY), [projectId]);

  useProjectEvents(projectId, useCallback((event) => {
    setState((prev) => reduceActivity(prev, event, Date.now()));
  }, []));

  // Fetched fresh on every mount (gcTime 0): a cached snapshot could seed a run that has ended.
  const { data: snapshot, error } = useQuery({
    queryKey: ['activity', projectId],
    queryFn: () => activityApi.get(projectId),
    enabled: Number.isFinite(projectId) && projectId > 0,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  useEffect(() => {
    if (error) console.error('failed to load running activity', error);
  }, [error]);

  const seeded = useRef<ActivitySnapshotDto | null>(null);
  useEffect(() => {
    if (!snapshot || seeded.current === snapshot) return;
    seeded.current = snapshot;
    setState((prev) => seedActivity(prev, snapshot));
  }, [snapshot]);

  const dismiss = useCallback(() => setState(dismissFinished), []);
  return { state, dismiss };
}
