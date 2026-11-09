// Rows for the build dialog's Nodes table, from either source: the Impact view (what's shown)
// or the backend's state preview (what changed vs production). Pure; tested in buildRows.test.ts.
import type { Impact } from '../../lib/impact';
import type { StatePreviewDto, StatePreviewNode } from '../../../../lib/slimApi';

export interface NodeRow {
  name: string;
  type: string;
  status: string;
  why: string;
  /** dbt build builds it (false for sources, exposures, metrics, semantic models, saved queries) */
  buildable: boolean;
  /** part of the build (or, for non-buildable nodes, affected) */
  selected: boolean;
}

export interface RowCounts {
  changed: number;
  toBuild: number;
  skipped: number;
  tests: number;
}

const UNBUILDABLE = new Set(['source', 'exposure', 'metric', 'semantic_model', 'saved_query', 'analysis']);

function changedColumns(n: StatePreviewNode): string {
  if (!n.columns) return 'changed';
  if (n.columns.length === 0) return 'changed, but no column did (whitespace or comments only)';
  return `changed: ${n.columns.slice(0, 6).join(', ')}${n.columns.length > 6 ? ', …' : ''}`;
}

function previewStatus(n: StatePreviewNode): string {
  if (n.changed) return 'changed';
  if (!n.buildable) return n.selected ? 'affected' : 'unaffected';
  return n.selected ? 'build' : 'skip';
}

function previewWhy(n: StatePreviewNode): string {
  if (n.changed) return changedColumns(n);
  const cols = n.columns && n.columns.length ? ` (${n.columns.slice(0, 6).join(', ')}${n.columns.length > 6 ? ', …' : ''})` : '';
  const why = (n.reason ?? 'downstream') + cols;
  return n.buildable ? why : `${why} · not built by dbt build`;
}

export function rowsFromPreview(preview: StatePreviewDto): NodeRow[] {
  return preview.nodes.map((n) => ({
    name: n.name, type: n.resource_type, status: previewStatus(n), why: previewWhy(n), buildable: n.buildable, selected: n.selected,
  }));
}

/** What the Impact table shows: the changed / selected nodes, then everything downstream by depth. */
export function rowsFromImpact(impact: Impact | null, changeMode: boolean): NodeRow[] {
  if (!impact) return [];
  const seed = changeMode ? 'changed' : 'selected';
  const row = (n: Impact['seeds'][number], status: string, why: string): NodeRow => {
    const buildable = !UNBUILDABLE.has(n.node.resource_type);
    return { name: n.node.name, type: n.node.resource_type, status: buildable ? status : 'affected', why: buildable ? why : `${why} · not built by dbt build`, buildable, selected: true };
  };
  return [
    ...impact.seeds.map((n) => row(n, seed, changeMode ? 'changed in git' : 'selected')),
    ...impact.levels.flatMap((level) => level.nodes.map((n) => row(n, 'build', `downstream, depth ${level.depth}`))),
  ];
}

export function countRows(rows: readonly NodeRow[], tests: number): RowCounts {
  const buildable = rows.filter((r) => r.buildable);
  const toBuild = buildable.filter((r) => r.selected).length;
  return { changed: rows.filter((r) => r.status === 'changed').length, toBuild, skipped: buildable.length - toBuild, tests };
}
