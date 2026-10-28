// sessionStorage keys for the SQL Workspace's per-project state. Shared so other pages
// can hand it a file to open (Metrics → "Open in Workspace").
export const OPEN_KEY = (id: number) => `ws-open-${id}`;
export const EXPANDED_KEY = (id: number) => `ws-expanded-${id}`;
export const RESULTS_KEY = (id: number) => `ws-results-${id}`;
export const CONTENT_KEY = (id: number | string, path: string) => `ws-content-${id}-${path}`;
export const TAB_KEY = (id: number) => `ws-tab-${id}`;
