import { describe, expect, it } from 'vitest';
import type { ModelNode } from '../../../../lib/api';
import type { Impact, ImpactNode } from '../../lib/impact';
import type { StatePreviewDto } from '../../../../lib/slimApi';
import { countRows, rowsFromImpact, rowsFromPreview } from './buildRows';

const impactNode = (name: string, type: string, depth: number): ImpactNode =>
  ({ node: { name, resource_type: type } as ModelNode, depth, dataTests: 0, unitTests: 0, flags: [] } as unknown as ImpactNode);

const impact = {
  seeds: [impactNode('orders', 'model', 0)],
  levels: [{ depth: 1, nodes: [impactNode('revenue', 'model', 1), impactNode('rev', 'metric', 1)] }],
  summary: {} as Impact['summary'],
} as Impact;

describe('rowsFromImpact', () => {
  it('lists the changed nodes then downstream, marking what dbt build skips', () => {
    const rows = rowsFromImpact(impact, true);
    expect(rows.map((r) => [r.name, r.status, r.buildable])).toEqual([
      ['orders', 'changed', true], ['revenue', 'build', true], ['rev', 'affected', false],
    ]);
    expect(rows[1].why).toBe('downstream, depth 1');
    expect(rowsFromImpact(impact, false)[0].status).toBe('selected');
    expect(rowsFromImpact(null, true)).toEqual([]);
  });

  it('counts only buildable nodes as to build', () => {
    expect(countRows(rowsFromImpact(impact, true), 4)).toEqual({ changed: 1, toBuild: 2, skipped: 0, tests: 4 });
  });
});

describe('rowsFromPreview', () => {
  it('explains changed columns, skips and non-buildable nodes', () => {
    const preview = {
      nodes: [
        { unique_id: 'a', name: 'a', resource_type: 'model', changed: true, selected: true, buildable: true, reason: 'changed', columns: [] },
        { unique_id: 'b', name: 'b', resource_type: 'model', changed: false, selected: false, buildable: true, reason: "doesn't read the changed columns", columns: null },
        { unique_id: 'm', name: 'm', resource_type: 'metric', changed: false, selected: true, buildable: false, reason: null, columns: null },
      ],
    } as unknown as StatePreviewDto;
    const rows = rowsFromPreview(preview);
    expect(rows.map((r) => r.status)).toEqual(['changed', 'skip', 'affected']);
    expect(rows[0].why).toBe('changed, but no column did (whitespace or comments only)');
    expect(rows[2].why).toBe('downstream · not built by dbt build');
    expect(countRows(rows, 0)).toEqual({ changed: 1, toBuild: 1, skipped: 1, tests: 0 });
  });
});
