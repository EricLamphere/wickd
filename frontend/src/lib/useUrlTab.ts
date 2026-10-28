import { useCallback, useEffect, useState } from 'react';
import { useLocation, useSearchParams, type SetURLSearchParams } from 'react-router-dom';
import { createRestoreQueue, pickTab, readStored, urlTabKey, writeStored } from './stickyTab';

// The latest setSearchParams; every hook instance shares one router, so any of them can flush
let latestSetter: SetURLSearchParams | null = null;
const queueRestore = createRestoreQueue((entries) => {
  latestSetter?.((prev) => {
    const next = new URLSearchParams(prev);
    for (const [param, value] of entries) next.set(param, value);
    return next;
  }, { replace: true });
});

/**
 * In-page tab state kept in a URL search param, so switching tabs pushes a
 * history entry the header back/forward arrows can step through.
 *
 * Sticky: the tab is remembered for the session (per page path, which includes the
 * project, and param), and restored when the URL has none, written back with
 * `replace` so going back to this entry later shows the same tab. Pass
 * `rememberKey` to choose the storage key, or `null` when the page restores its
 * own view (Docs).
 */
export function useUrlTab<T extends string>(
  param: string,
  allowed: readonly T[],
  fallback: T,
  rememberKey?: string | null,
): [T, (next: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  latestSetter = setSearchParams;
  const key = rememberKey === undefined ? urlTabKey(pathname, param) : rememberKey;

  const raw = searchParams.get(param);
  const tab = pickTab(allowed, fallback, raw, key ? readStored(key) : null);
  const missing = raw === null;

  useEffect(() => {
    if (key) writeStored(key, tab);
  }, [key, tab]);

  useEffect(() => {
    if (key && missing) queueRestore(param, tab);
  }, [key, missing, param, tab]);

  const setTab = useCallback((next: T) => {
    if (next === tab) return;
    setSearchParams((prev) => {
      const updated = new URLSearchParams(prev);
      updated.set(param, next);
      return updated;
    });
  }, [param, tab, setSearchParams]);

  return [tab, setTab];
}

/**
 * An inner tab kept in local state (not in the URL) that's still sticky: remembered
 * for the session under `key` (include the project id), and falling back when the
 * remembered tab isn't offered here. `key` null = not remembered.
 */
export function useStickyTab<T extends string>(key: string | null, allowed: readonly T[], fallback: T): [T, (next: T) => void] {
  const [chosen, setChosen] = useState<string | null>(() => (key ? readStored(key) : null));
  const tab = pickTab(allowed, fallback, chosen);
  const setTab = useCallback((next: T) => {
    setChosen(next);
    if (key) writeStored(key, next);
  }, [key]);
  return [tab, setTab];
}
