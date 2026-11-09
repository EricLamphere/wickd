// After Build impacted… builds the changed models, the Impact tab's Data diff section offers to
// compare them with prod (no second build). Module state rather than React state: the build dialog
// closes as the build starts, and the Impact tab may be unmounted while it runs.
import { useCallback, useSyncExternalStore } from 'react';
import { useProjectEvents } from '../../../lib/sse';

/** queued = asked for, not started yet (another run may hold the lock); built = finished OK */
export type BuildNudgeState = 'queued' | 'building' | 'built';

interface NudgeEvent { type: string; data: unknown }

/** The next state after a project event; null drops the nudge. */
export function nudgeAfterEvent(prev: BuildNudgeState | null, event: NudgeEvent): BuildNudgeState | null {
  if (prev === null || prev === 'built') return prev;
  const data = (event.data ?? {}) as { command?: string; return_code?: number };
  if (event.type === 'run_error') return null;
  if (data.command !== 'build') return prev;
  if (event.type === 'run_started' && prev === 'queued') return 'building';
  if (event.type === 'run_finished' && prev === 'building') return data.return_code === 0 ? 'built' : null;
  return prev;
}

let store: ReadonlyMap<number, BuildNudgeState> = new Map();
const listeners = new Set<() => void>();

function setNudge(projectId: number, state: BuildNudgeState | null): void {
  if ((store.get(projectId) ?? null) === state) return;
  const next = new Map(store);
  if (state) next.set(projectId, state);
  else next.delete(projectId);
  store = next;
  listeners.forEach((l) => l());
}

/** Build impacted… started a build of the changed models. */
export function markBuildForDiff(projectId: number): void {
  setNudge(projectId, 'queued');
}

export function dismissBuildNudge(projectId: number): void {
  setNudge(projectId, null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBuildNudge(projectId: number): BuildNudgeState | null {
  return useSyncExternalStore(subscribe, () => store.get(projectId) ?? null);
}

/** Mount once in an always-mounted component (BottomPane) so no run event is missed. */
export function useBuildNudgeTracker(projectId: number): void {
  useProjectEvents(projectId, useCallback((event) => {
    const prev = store.get(projectId) ?? null;
    if (prev) setNudge(projectId, nudgeAfterEvent(prev, event));
  }, [projectId]));
}
