import type { GraphDto, ModelNode, SemanticInfo } from '../../../lib/api';

/** dbt semantic layer resource types (semantic models, metrics, saved queries). */
export const SEMANTIC_TYPES = ['semantic_model', 'metric', 'saved_query'] as const;
export type SemanticType = (typeof SEMANTIC_TYPES)[number];

export function isSemanticType(resourceType: string): resourceType is SemanticType {
  return (SEMANTIC_TYPES as readonly string[]).includes(resourceType);
}

/** Display name: a metric's label when it has one, else its name. */
export function semanticDisplayName(node: ModelNode): string {
  return node.label || node.name;
}

/** e.g. "sum(amount)", "ratio: revenue / order_count", "derived: revenue / buyers". */
export function describeMetric(s: SemanticInfo): string {
  const type = s.type ?? 'metric';
  if (type === 'simple') {
    if (s.agg) return s.expr ? `${s.agg}(${s.expr})` : s.agg;
    return s.measure ? `measure ${s.measure}` : 'simple';
  }
  if (type === 'ratio' && s.numerator && s.denominator) return `ratio: ${s.numerator} / ${s.denominator}`;
  if (type === 'derived' && s.expr) return `derived: ${s.expr}`;
  if (type === 'cumulative') {
    const input = s.measure ?? s.input_metrics?.[0];
    const window = s.window ? ` over ${s.window}` : s.grain_to_date ? ` ${s.grain_to_date} to date` : '';
    return input ? `cumulative ${input}${window}` : 'cumulative';
  }
  return type;
}

/** Nodes of `types` directly downstream of `uid`, sorted by name. */
export function childrenOfType(graph: GraphDto, uid: string, types: readonly string[]): ModelNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.unique_id, n]));
  const out = new Map<string, ModelNode>();
  for (const { source, target } of graph.edges) {
    if (source !== uid) continue;
    const n = byId.get(target);
    if (n && types.includes(n.resource_type)) out.set(n.unique_id, n);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Semantic nodes in the graph, grouped by type and sorted by name. */
export function semanticNodesByType(graph: GraphDto): Record<SemanticType, ModelNode[]> {
  const groups: Record<SemanticType, ModelNode[]> = { semantic_model: [], metric: [], saved_query: [] };
  for (const n of graph.nodes) if (isSemanticType(n.resource_type)) groups[n.resource_type].push(n);
  for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}
