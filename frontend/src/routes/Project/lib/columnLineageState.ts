/** The fields both the full snapshot and the status endpoint report about the cache. */
export interface LineageCacheState {
  status: 'running' | 'done' | 'error' | null;
  stale: boolean;
  refresh_status: 'running' | 'error' | null;
  refresh_error: string | null;
  error_message: string | null;
}

/** What a column lineage control offers: nothing while the cache is current, Refresh only once it's out of date. */
export type LineageAction = 'locked' | 'loading' | 'load' | 'refresh' | 'none';

export function lineageAction(input: {
  locked: boolean;
  loading: boolean;
  snapshot: LineageCacheState | null | undefined;
}): LineageAction {
  if (input.locked) return 'locked';
  if (input.loading) return 'loading';
  const snap = input.snapshot;
  if (!snap || snap.status !== 'done') return 'load';
  return snap.stale ? 'refresh' : 'none';
}

/** A scan is in progress: the first one (no cache yet) or a refresh behind the cached snapshot. */
export function isLineageScanning(snap: LineageCacheState | null | undefined): boolean {
  return snap?.status === 'running' || snap?.refresh_status === 'running';
}

/** The latest scan's error, whether it was the first scan or a refresh behind the cache. */
export function lineageScanError(snap: LineageCacheState | null | undefined): string | null {
  if (!snap) return null;
  if (snap.refresh_status === 'error') return snap.refresh_error ?? 'Refreshing column lineage failed';
  return snap.status === 'error' ? snap.error_message : null;
}
