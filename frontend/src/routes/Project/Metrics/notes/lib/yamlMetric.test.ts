import { describe, expect, it } from 'vitest';
import { metricAtLine } from './yamlMetric';

const YAML = `semantic_models:
  - name: orders
    measures:
      - name: order_total

metrics:
  - name: revenue
    label: Revenue
    type: simple
    type_params:
      measure: order_total
    filter: |
      {{ Dimension('order__region') }} = 'EU'

  - label: Orders
    name: orders_count
    type: simple
`;

describe('metricAtLine', () => {
  it('finds the metric on its name line and inside its block', () => {
    expect(metricAtLine(YAML, 7)).toBe('revenue');
    expect(metricAtLine(YAML, 11)).toBe('revenue');
    expect(metricAtLine(YAML, 14)).toBe('revenue');
  });
  it('reads a name that is not on the dash line', () => {
    expect(metricAtLine(YAML, 16)).toBe('orders_count');
    expect(metricAtLine(YAML, 18)).toBe('orders_count');
  });
  it('ignores items of other lists', () => {
    expect(metricAtLine(YAML, 2)).toBeNull();
    expect(metricAtLine(YAML, 4)).toBeNull();
    expect(metricAtLine(YAML, 6)).toBeNull();
  });
  it('handles an empty file', () => {
    expect(metricAtLine('', 1)).toBeNull();
  });
});
