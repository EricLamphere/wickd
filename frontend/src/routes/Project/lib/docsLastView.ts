/** Search params the Docs page owns: the selected node and its browse/detail tabs. */
const DOCS_PARAMS = ['node', 'browse', 'view'] as const;
const PROJECT_OVERVIEW = '__project__';

export function readSessionValue(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

/**
 * The remembered Docs view (a query string) to restore on arriving at Docs
 * without a selection, or null when there's nothing usable — e.g. the node was
 * removed from the project since.
 */
export function restorableDocsView(stored: string | null, nodeExists: (uid: string) => boolean): URLSearchParams | null {
  if (!stored) return null;
  const parsed = new URLSearchParams(stored);
  const node = parsed.get('node');
  if (!node || (node !== PROJECT_OVERVIEW && !nodeExists(node))) return null;
  const view = new URLSearchParams();
  for (const key of DOCS_PARAMS) {
    const value = parsed.get(key);
    if (value !== null) view.set(key, value);
  }
  return view;
}
