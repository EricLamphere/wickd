import type { TagFlowColumnDto, TagFlowDto } from '../../../lib/propagationApi';
import type { PropagationHop } from '../../../lib/aiApi';

export type TagFlowStatus = 'Declared' | 'Inherited' | 'Derived';

export const TAG_FLOW_COLUMNS = ['Node', 'Column', 'Type', 'Status', 'Path'] as const;

export function tagFlowStatus(c: TagFlowColumnDto): TagFlowStatus {
  if (c.declared) return 'Declared';
  return c.via_kind === 'derived' ? 'Derived' : 'Inherited';
}

function hopName(hop: PropagationHop): string {
  return `${hop.node.split('.').pop()}.${hop.column}`;
}

/** "raw.email → stg.email (renamed) → mart.email_hash (derived)"; empty for a declaring column. */
export function pathText(path: PropagationHop[]): string {
  if (path.length < 2) return '';
  return path
    .map((hop, i) => {
      if (i === 0 || !hop.kind || hop.kind === 'identity') return hopName(hop);
      return `${hopName(hop)} (${hop.kind === 'rename' ? 'renamed' : hop.kind})`;
    })
    .join(' → ');
}

const STATUS_ORDER: Record<TagFlowStatus, number> = { Declared: 0, Inherited: 1, Derived: 2 };

/** DataTable rows: declared columns first, then inherited, then derived; by node and column within each. */
export function tagFlowRows(flow: TagFlowDto): unknown[][] {
  return [...flow.columns]
    .sort((a, b) =>
      STATUS_ORDER[tagFlowStatus(a)] - STATUS_ORDER[tagFlowStatus(b)]
      || a.name.localeCompare(b.name)
      || a.column.localeCompare(b.column))
    .map((c) => [c.name, c.column, c.resource_type, tagFlowStatus(c), pathText(c.path)]);
}

export function tagFlowCounts(flow: TagFlowDto): Record<TagFlowStatus, number> {
  const counts: Record<TagFlowStatus, number> = { Declared: 0, Inherited: 0, Derived: 0 };
  for (const c of flow.columns) counts[tagFlowStatus(c)] += 1;
  return counts;
}

/** What "Show in DAG" opens: every reached column selected (`uid::column`), its node expanded. */
export function dagSelection(flow: TagFlowDto): { columnKeys: string[]; expanded: string[] } {
  return {
    columnKeys: flow.columns.map((c) => `${c.unique_id}::${c.column}`),
    expanded: [...new Set(flow.columns.map((c) => c.unique_id))],
  };
}
