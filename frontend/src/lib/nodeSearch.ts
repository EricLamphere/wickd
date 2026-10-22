import type { NodeSearchHit } from './api';

/** Shorter queries match almost everything — the home page waits for two characters. */
export const MIN_NODE_QUERY_LENGTH = 2;

export function isNodeQuery(query: string): boolean {
  return query.trim().length >= MIN_NODE_QUERY_LENGTH;
}

/** Where a search hit opens: the DAG (selected) by default, or the node's file in Files. */
export function nodeSearchUrl(hit: NodeSearchHit, target: 'dag' | 'files' = 'dag'): string {
  const page = target === 'dag' ? 'models' : 'files';
  return `/projects/${hit.project_id}/${page}?model=${encodeURIComponent(hit.unique_id)}`;
}

/** Secondary line for a hit: project · column match · file. */
export function nodeSearchSubtitle(hit: NodeSearchHit): string {
  const parts = [hit.project_name];
  if (hit.matched_column) parts.push(`column ${hit.matched_column}`);
  if (hit.original_file_path) parts.push(hit.original_file_path);
  return parts.join(' · ');
}

/** "Not searchable yet" hint for projects without a manifest, or null when every project is indexed. */
export function unindexedNotice(unindexedIds: number[], projects: { id: number; name: string }[]): string | null {
  if (unindexedIds.length === 0) return null;
  const ids = new Set(unindexedIds);
  const names = projects.filter((p) => ids.has(p.id)).map((p) => p.name);
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : '';
  const verb = names.length === 1 ? "hasn't" : "haven't";
  return `${shown}${rest} ${verb} been compiled yet, so ${names.length === 1 ? "it isn't" : "they aren't"} searched.`;
}
