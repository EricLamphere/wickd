import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isProFeatureRequiredError } from '../../../lib/api';
import { dataDiffApi, type StartDataDiff } from '../../../lib/dataDiffApi';
import { useProjectEvents } from '../../../lib/sse';
import { dataDiffStartError, latestByModel } from './dataDiff';

/**
 * The latest data diff (Pro) per model, plus start() / cancel(). Refetched on data_diff_started /
 * data_diff_finished; `phase` follows data_diff_progress while a job runs. `locked` = no Pro
 * entitlement. Results aren't invalidated on file changes: a diff is a deliberate check. statuses_changed
 * refetches so a diff whose dev relation was rebuilt since shows as stale.
 */
export function useDataDiff(projectId: number, enabled: boolean) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [lockedOnStart, setLockedOnStart] = useState(false);

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'data_diff_started' || event.type === 'data_diff_finished') {
      setPhase(null);
      qc.invalidateQueries({ queryKey: ['data-diff', projectId] });
    }
    if (event.type === 'data_diff_progress') setPhase((event.data as { phase: string }).phase);
    // a run, build or clone may have rebuilt a diffed model in dev: refetch so its result shows as stale
    if (event.type === 'statuses_changed') qc.invalidateQueries({ queryKey: ['data-diff', projectId] });
  }, [projectId, qc]));

  const query = useQuery({
    queryKey: ['data-diff', projectId],
    queryFn: () => dataDiffApi.latest(projectId),
    enabled: enabled && !!projectId,
    retry: (failureCount, err) => !isProFeatureRequiredError(err) && failureCount < 2,
  });

  const start = useCallback(async (body: StartDataDiff) => {
    setStarting(true);
    setStartError(null);
    try {
      await dataDiffApi.start(projectId, body);
      qc.invalidateQueries({ queryKey: ['data-diff', projectId] });
    } catch (err) {
      if (isProFeatureRequiredError(err)) setLockedOnStart(true);
      else setStartError(dataDiffStartError(err));
    } finally {
      setStarting(false);
    }
  }, [projectId, qc]);

  const cancel = useCallback(async () => {
    try {
      await dataDiffApi.cancel(projectId);
    } catch (err) {
      setStartError(dataDiffStartError(err));
    }
  }, [projectId]);

  const byModel = useMemo(() => latestByModel(query.data), [query.data]);
  const running = starting || (query.data ?? []).some((d) => d.status === 'running');
  return {
    byModel,
    running,
    phase: running ? phase ?? (query.data ?? []).find((d) => d.status === 'running')?.phase ?? null : null,
    locked: lockedOnStart || isProFeatureRequiredError(query.error),
    loadError: query.error && !isProFeatureRequiredError(query.error) ? dataDiffStartError(query.error) : null,
    startError,
    start,
    cancel,
  };
}

export type DataDiffState = ReturnType<typeof useDataDiff>;
