import { describe, expect, it } from 'vitest';
import type { ColumnDrift, ModelDriftResult } from '../../../../lib/api';
import { categorize, columnSummary, matchesSearch, skippedLabel } from './driftView';

const col = (name: string, in_manifest: boolean, in_warehouse: boolean): ColumnDrift => ({
  name, in_manifest, in_warehouse, manifest_type: '', warehouse_type: '', type_mismatch: false,
});

const result = (name: string, over: Partial<ModelDriftResult> = {}): ModelDriftResult => ({
  unique_id: `model.p.${name}`, name, materialized: 'table', error: null, columns: [],
  has_drift: false, not_built: false, yaml_path: null, ...over,
});

describe('categorize', () => {
  it('splits results into drifted, not built, errors and in sync', () => {
    const groups = categorize([
      result('a', { has_drift: true }),
      result('b', { not_built: true, error: 'not built' }),
      result('c', { error: 'boom' }),
      result('d'),
    ]);
    expect(groups.drifted.map((r) => r.name)).toEqual(['a']);
    expect(groups.notBuilt.map((r) => r.name)).toEqual(['b']);
    expect(groups.errors.map((r) => r.name)).toEqual(['c']);
    expect(groups.inSync.map((r) => r.name)).toEqual(['d']);
  });
});

describe('columnSummary', () => {
  it('counts each kind of drift', () => {
    const r = result('a', { columns: [col('x', false, true), col('y', false, true), col('z', true, false), col('ok', true, true)] });
    expect(columnSummary(r)).toBe('2 warehouse-only · 1 manifest-only');
  });
});

describe('matchesSearch', () => {
  it('matches model names case-insensitively, and everything when empty', () => {
    expect(matchesSearch(result('Orders_Daily'), 'orders')).toBe(true);
    expect(matchesSearch(result('customers'), 'orders')).toBe(false);
    expect(matchesSearch(result('customers'), '  ')).toBe(true);
  });
});

describe('skippedLabel', () => {
  it('describes skipped models, largest group first', () => {
    expect(skippedLabel({ ephemeral: 2, view: 7 })).toBe('9 skipped (7 view, 2 ephemeral)');
    expect(skippedLabel({})).toBeNull();
  });
});
