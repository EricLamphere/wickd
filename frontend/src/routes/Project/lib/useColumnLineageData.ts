import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, isProFeatureRequiredError } from '../../../lib/api';
import { useProjectEvents } from '../../../lib/sse';
import { isLineageScanning, lineageAction, lineageScanError } from './columnLineageState';

/** Snapshots older than this lack row dependencies, which column-level impact needs. */
export const IMPACT_LINEAGE_VERSION = 2;

function startErrorMessage(err: unknown): string | null {
  if (err instanceof ApiError && err.status === 409) return null; // already running; its events update the query
  if (err instanceof ApiError && err.status === 503) return 'Column lineage is unavailable in this build (the wickd Pro package is not installed).';
  if (err instanceof ApiError && err.status === 422) return 'Column lineage needs a compiled project. Use Refresh DAG first.';
  if (err instanceof ApiError && typeof err.body === 'string') return err.body;
  return err instanceof Error ? err.message : 'Failed to start column lineage';
}

/**
 * The project's cached column lineage snapshot (Pro; the latest finished one, kept while a
 * refresh runs), whether it's out of date, and a `start()` that computes it — or returns the
 * cache when it's current. Shares the ['column-lineage', id] query with the DAG page; progress
 * arrives over SSE.
 */
export function useColumnLineageData(projectId: number, enabled: boolean) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<{ checked: number; total: number } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'column_lineage_compiling') setCompiling(true);
    // a scan began (refresh_status), or the manifest changed (the cache may now be out of date)
    if (event.type === 'column_lineage_started' || event.type === 'graph_changed') {
      qc.invalidateQueries({ queryKey: ['column-lineage', projectId] });
      qc.invalidateQueries({ queryKey: ['column-lineage-status', projectId] });
    }
    if (event.type === 'column_lineage_progress') {
      const d = event.data as { checked: number; total: number };
      setCompiling(false);
      setProgress({ checked: d.checked, total: d.total });
    }
    if (event.type === 'column_lineage_finished') {
      setCompiling(false);
      setProgress(null);
      qc.invalidateQueries({ queryKey: ['column-lineage', projectId] });
      qc.invalidateQueries({ queryKey: ['column-lineage-status', projectId] });
    }
  }, [projectId, qc]));

  const query = useQuery({
    queryKey: ['column-lineage', projectId],
    queryFn: () => api.models.columnLineage(projectId),
    enabled: enabled && !!projectId,
    staleTime: Infinity,
    retry: (failureCount, err) => !isProFeatureRequiredError(err) && failureCount < 3,
  });
  // Small (no results), so fetched even when the snapshot isn't: decides Load / Refresh / nothing.
  const status = useQuery({
    queryKey: ['column-lineage-status', projectId],
    queryFn: () => api.models.columnLineageStatus(projectId),
    enabled: !!projectId,
    staleTime: Infinity,
    retry: (failureCount, err) => !isProFeatureRequiredError(err) && failureCount < 3,
  });

  const start = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      await api.models.startColumnLineage(projectId);
      qc.invalidateQueries({ queryKey: ['column-lineage', projectId] });
      qc.invalidateQueries({ queryKey: ['column-lineage-status', projectId] });
    } catch (err) {
      if (isProFeatureRequiredError(err)) setLocked(true);
      else setStartError(startErrorMessage(err));
    } finally {
      setStarting(false);
    }
  }, [projectId, qc]);

  const snapshot = query.data ?? null;
  const cache = status.data ?? snapshot;
  const running = compiling || starting || isLineageScanning(cache);
  const isLocked = locked || isProFeatureRequiredError(query.error) || isProFeatureRequiredError(status.error);
  return {
    snapshot,
    /** Finished and new enough to include row dependencies (possibly out of date: see `stale`). */
    ready: snapshot?.status === 'done' && snapshot.lineage_version >= IMPACT_LINEAGE_VERSION,
    /** The cache no longer matches the project; `staleReason` says why. */
    stale: cache?.status === 'done' && cache.stale,
    staleReason: cache?.status === 'done' ? cache.stale_reason : null,
    /** What a control should offer: load, refresh (only when stale), or nothing. */
    action: lineageAction({ locked: isLocked, loading: running, snapshot: cache }),
    running,
    compiling,
    progress,
    locked: isLocked,
    error: startError ?? lineageScanError(cache),
    start,
  };
}
