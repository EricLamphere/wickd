// Sticky tabs: the tab you were on is remembered for the session (sessionStorage),
// so leaving a page and coming back shows the same tab. Pure helpers; unit-tested in
// stickyTab.test.ts. Hooks: useUrlTab (top-level page tabs, in the URL) and
// useStickyTab (inner tabs kept in local state).

export function readStored(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

export function writeStored(key: string, value: string): void {
  try { sessionStorage.setItem(key, value); } catch { /* storage unavailable — the tab just isn't remembered */ }
}

/** The first allowed of: the URL's value, the remembered one, the fallback. */
export function pickTab<T extends string>(allowed: readonly T[], fallback: T, ...candidates: (string | null)[]): T {
  const ok = (v: string | null): v is T => v !== null && (allowed as readonly string[]).includes(v);
  return candidates.find(ok) ?? fallback;
}

/** Default remember key for a URL tab: per page path (which includes the project) and param. */
export function urlTabKey(pathname: string, param: string): string {
  return `url-tab:${pathname.replace(/\/+$/, '')}:${param}`;
}

/**
 * Restores of several URL tabs in one render (a page tab and a sub-tab inside it) must
 * be one URL write: separate `replace` writes from the same render each start from the
 * same old URL, so the last one would undo the others. Calls in the same tick are
 * merged and flushed once.
 */
export function createRestoreQueue(flush: (entries: [string, string][]) => void) {
  const pending = new Map<string, string>();
  let scheduled = false;
  return (param: string, value: string) => {
    pending.set(param, value);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const entries = [...pending];
      pending.clear();
      flush(entries);
    });
  };
}
