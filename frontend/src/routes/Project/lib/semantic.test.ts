import { describe, expect, it } from 'vitest';
import type { GraphDto, ModelNode, SemanticInfo } from '../../../lib/api';
import { childrenOfType, describeMetric, isSemanticType, semanticDisplayName, semanticNodesByType } from './semantic';

function node(uid: string, semantic: SemanticInfo | null = null, label: string | null = null): ModelNode {
  const [resource_type, , name] = uid.split('.');
  return {
    unique_id: uid, name, resource_type, schema_: null, database: null, materialized: null, tags: [],
    description: '', original_file_path: null, source_name: null, status: 'idle', message: null, columns: [],
    test_metadata_name: null, column_name: null, attached_node: null, patch_path: null, label, semantic,
  };
}

describe('semantic helpers', () => {
  it('recognises semantic types', () => {
    expect(isSemanticType('metric')).toBe(true);
    expect(isSemanticType('saved_query')).toBe(true);
    expect(isSemanticType('model')).toBe(false);
  });

  it('prefers the label for display', () => {
    expect(semanticDisplayName(node('metric.p.revenue', null, 'Revenue'))).toBe('Revenue');
    expect(semanticDisplayName(node('metric.p.revenue'))).toBe('revenue');
  });

  it('describes each metric type', () => {
    expect(describeMetric({ type: 'simple', agg: 'sum', expr: 'amount' })).toBe('sum(amount)');
    expect(describeMetric({ type: 'simple', measure: 'revenue' })).toBe('measure revenue');
    expect(describeMetric({ type: 'ratio', numerator: 'r', denominator: 'o' })).toBe('ratio: r / o');
    expect(describeMetric({ type: 'derived', expr: 'r / b' })).toBe('derived: r / b');
    expect(describeMetric({ type: 'cumulative', input_metrics: ['revenue'], window: '7 days' }))
      .toBe('cumulative revenue over 7 days');
    expect(describeMetric({ type: 'conversion' })).toBe('conversion');
  });

  it('finds children of a type and groups semantic nodes', () => {
    const graph: GraphDto = {
      nodes: [node('semantic_model.p.orders'), node('metric.p.b'), node('metric.p.a'), node('saved_query.p.q'), node('model.p.m')],
      edges: [
        { source: 'semantic_model.p.orders', target: 'metric.p.b' },
        { source: 'semantic_model.p.orders', target: 'metric.p.a' },
        { source: 'metric.p.a', target: 'saved_query.p.q' },
      ],
      unit_tests: [],
    };
    expect(childrenOfType(graph, 'semantic_model.p.orders', ['metric']).map((n) => n.name)).toEqual(['a', 'b']);
    const groups = semanticNodesByType(graph);
    expect(groups.metric.map((n) => n.name)).toEqual(['a', 'b']);
    expect(groups.saved_query).toHaveLength(1);
    expect(groups.semantic_model).toHaveLength(1);
  });
});
