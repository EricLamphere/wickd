import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isProFeatureRequiredError } from '../../../../lib/api';
import { lineageNotReadyReason } from '../../../../lib/propagationApi';
import { useProjectEvents } from '../../../../lib/sse';
import { testGapsApi } from '../../../../lib/testGapsApi';
import { retryUnlessSettled, useProEntitled } from '../propagation/usePropagation';

/** Lineage re-traced, YAML edited (tests added), manifest rebuilt, a proposal applied. */
const STALE_EVENTS = new Set(['column_lineage_finished', 'graph_changed', 'files_changed', 'ai_proposal_updated']);

/** The ranked Test gaps list (['test-gaps', id, limit]); Pro, needs a lineage scan with join keys and grain. */
export function useTestGaps(projectId: number, limit: number) {
  const qc = useQueryClient();
  const { entitled, loading } = useProEntitled();

  useProjectEvents(projectId, useCallback((event) => {
    if (STALE_EVENTS.has(event.type)) qc.invalidateQueries({ queryKey: ['test-gaps', projectId] });
  }, [projectId, qc]));

  const query = useQuery({
    queryKey: ['test-gaps', projectId, limit],
    queryFn: () => testGapsApi.list(projectId, limit),
    enabled: entitled,
    retry: retryUnlessSettled,
  });

  return {
    data: query.data ?? null,
    loading: loading || (entitled && query.isLoading),
    locked: (!loading && !entitled) || isProFeatureRequiredError(query.error),
    notReady: lineageNotReadyReason(query.error),
    error: query.error,
  };
}

/** Ignored rows (['test-gaps', id, 'ignored']; same prefix, so the same events refresh it). */
export function useIgnoredGaps(projectId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['test-gaps', projectId, 'ignored'],
    queryFn: () => testGapsApi.ignored(projectId),
    enabled,
    retry: retryUnlessSettled,
  });
}

/** Ignore / unignore rows; both lists (and the tab badge and overview card) refetch after. */
export function useIgnoreGaps(projectId: number) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['test-gaps', projectId] });
    }
  }, [projectId, qc]);

  return {
    ignore: (keys: string[]) => run(() => testGapsApi.ignore(projectId, keys)),
    unignore: (keys: string[]) => run(() => testGapsApi.unignore(projectId, keys)),
    busy,
    error,
  };
}
