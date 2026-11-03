import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api';
import type { DataDiffDto, DataDiffResult } from '../../../lib/dataDiffApi';
import {
  countSegments, dataDiffStartError, diffBadge, formatDelta, formatPct, isDiffable, latestByModel,
  parseKeyInput, phaseLabel, sampleTable,
} from './dataDiff';

const schema = { added: [], removed: [], retyped: [] };

function dto(over: Partial<DataDiffDto> = {}, result: DataDiffResult | null = null): DataDiffDto {
  return {
    id: 1, unique_id: 'model.p.orders', name: 'orders', scope: 'working', base_ref: null, dev_target: 'dev',
    prod_target: 'prod', dev_relation: 'd', prod_relation: 'p', mode: 'joined', key: ['id'], key_source: 'contract',
    columns: null, where: null, built: true, status: 'done', phase: null, result, error_message: null,
    started_at: '', finished_at: null, ...over,
  };
}

describe('diffBadge', () => {
  it('summarises added, removed and changed rows', () => {
    const b = diffBadge(dto({}, { counts: { added: 12, removed: 3, changed: 1400, unchanged: 5 }, schema, headline: 'h' }));
    expect(b).toEqual({ text: '+12 −3 ~1,400 rows', tone: 'warn', title: 'h' });
  });
  it('marks estimates', () => {
    expect(diffBadge(dto({}, { counts: { added: 0, removed: 0, changed: 40 }, estimated: true, schema })).text).toBe('~≈40 rows');
  });
  it('no changes, schema-only changes and key-less diffs', () => {
    expect(diffBadge(dto({}, { counts: { added: 0, removed: 0, changed: 0 }, schema })).text).toBe('no changes');
    const retyped = { ...schema, retyped: [{ name: 'a', dev_type: 'int', prod_type: 'bigint' }] };
    expect(diffBadge(dto({}, { counts: { added: 0, removed: 0, changed: 0 }, schema: retyped })).text).toBe('schema changed');
    expect(diffBadge(dto({}, { counts: { dev_rows: 5, prod_rows: 4, added: null }, schema })).text).toBe('5 vs 4 rows');
    expect(diffBadge(dto({}, { counts: { dev_rows: 5, prod_rows: 5, added: null }, schema })).tone).toBe('ok');
  });
  it('running and errors', () => {
    expect(diffBadge(dto({ status: 'running', phase: 'building' }))).toMatchObject({ tone: 'running', title: 'Building in dev…' });
    const err = diffBadge(dto({ status: 'error', error_message: 'nope' }, { error: { code: 'prod_missing', message: 'x' } }));
    expect(err).toMatchObject({ text: 'not in prod', tone: 'warn', title: 'nope' });
    expect(diffBadge(dto({ status: 'error' })).text).toBe('diff failed');
  });
});

describe('sampleTable', () => {
  const result: DataDiffResult = {
    sample_columns: { key: ['id'], columns: ['amount', 'status', 'note'] },
    samples: {
      added: [{ key: [9], dev: [1, 'paid', null], prod: null, changed: [] }],
      removed: [{ key: [3], dev: null, prod: [2, 'open', 'x'], changed: [] }],
      changed: [
        { key: [5], dev: [10, 'paid', null], prod: [5, 'paid', null], changed: ['amount'] },
        { key: [7], dev: [1, 'open', 'hi'], prod: [1, 'open', null], changed: ['note'] },
      ],
    },
  };
  it('shows only the differing columns of changed rows, dev beside prod', () => {
    const t = sampleTable(result, 'changed');
    expect(t.columns).toEqual(['id', 'amount (dev)', 'amount (prod)', 'note (dev)', 'note (prod)']);
    expect(t.rows).toEqual([[5, 10, 5, null, null], [7, 1, 1, 'hi', null]]);
    expect([...t.changed].sort()).toEqual(['0:1', '0:2', '1:3', '1:4']);
  });
  it('added rows come from dev, removed rows from prod', () => {
    expect(sampleTable(result, 'added').rows).toEqual([[9, 1, 'paid', null]]);
    expect(sampleTable(result, 'removed').rows).toEqual([[3, 2, 'open', 'x']]);
    expect(sampleTable(null, 'added')).toEqual({ columns: [], rows: [], changed: new Set() });
  });
});

describe('helpers', () => {
  it('count segments', () => {
    expect(countSegments({ added: 1, removed: 0, changed: 1, unchanged: 2 })).toEqual([
      { status: 'unchanged', count: 2, pct: 50 }, { status: 'changed', count: 1, pct: 25 }, { status: 'added', count: 1, pct: 25 },
    ]);
    expect(countSegments({ added: null })).toEqual([]);
  });
  it('formats', () => {
    expect(formatDelta(-4210.554)).toBe('−4,210.55');
    expect(formatDelta(1e-12)).toBe('');
    expect(formatPct(0.117)).toBe('12%');
    expect(formatPct(0.051)).toBe('5.1%');
    expect(formatPct(0.0001)).toBe('<0.1%');
    expect(formatPct(0.5)).toBe('50%');
    expect(parseKeyInput(' a, b ,,')).toEqual(['a', 'b']);
    expect(phaseLabel('comparing')).toBe('Comparing rows…');
    expect(phaseLabel(null)).toBe('Diffing…');
  });
  it('diffable nodes and latest per model', () => {
    expect(isDiffable({ resource_type: 'model', materialized: 'table' })).toBe(true);
    expect(isDiffable({ resource_type: 'model', materialized: 'ephemeral' })).toBe(false);
    expect(isDiffable({ resource_type: 'source' })).toBe(false);
    expect(latestByModel([dto({ id: 1 }), dto({ id: 2 })]).get('model.p.orders')?.id).toBe(2);
  });
  it('start errors', () => {
    expect(dataDiffStartError(new ApiError(409, 'x', null))).toBeNull();
    expect(dataDiffStartError(new ApiError(400, 'x', { error: 'no_base_target', message: 'Set DIFF_BASE_TARGET' }))).toBe('Set DIFF_BASE_TARGET');
    expect(dataDiffStartError(new ApiError(503, 'x', null))).toMatch(/unavailable/);
  });
});
