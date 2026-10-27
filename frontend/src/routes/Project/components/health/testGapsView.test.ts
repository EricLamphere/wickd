import { describe, expect, it } from 'vitest';
import type { TestGapDto } from '../../../../lib/testGapsApi';
import {
  describeCandidate, describeUse, filterGaps, gapSubject, ignoredStatus, testCounts, testGapsBadge, testGapsCardState,
} from './testGapsView';

const ROW: TestGapDto = {
  key: 'model.p.stg_orders::customer_id', unique_id: 'model.p.stg_orders', name: 'stg_orders',
  column: 'customer_id', columns: null, score: 9, reach: 1, row_uses: 2, exposures: 1, in_grain: false,
  existing: [],
  candidates: [
    { test: 'not_null', evidence: 'inner-joined on in 2 models', source: 'join', to: null, field: null, combination: null, models: [] },
    { test: 'relationships', evidence: 'joined to `dim_customers.customer_id` in 2 models', source: 'join',
      to: 'model.p.dim_customers', field: 'customer_id', combination: null, models: [] },
  ],
};
const COMBO: TestGapDto = {
  ...ROW, key: 'model.p.daily::(day, status)', name: 'daily', column: null, columns: ['day', 'status'],
  reach: 0, row_uses: 0, exposures: 0, in_grain: true, score: 2,
  candidates: [{ test: 'unique_combination_of_columns', evidence: 'one row per (day, status)', source: 'grain',
    to: null, field: null, combination: ['day', 'status'], models: [] }],
};

describe('testGapsView', () => {
  it('describes candidates and use', () => {
    expect(describeCandidate(ROW.candidates[1])).toBe('relationships → dim_customers.customer_id');
    expect(describeUse(ROW)).toBe('1 column · 2 models filter/join · 1 exposure');
    expect(describeUse(COMBO)).toBe('grain');
    expect(describeUse({ reach: 0, row_uses: 0, exposures: 0, in_grain: false })).toBe('—');
  });

  it('counts test types and filters by search and type', () => {
    expect(testCounts([ROW, COMBO])).toEqual([['not_null', 1], ['relationships', 1], ['unique_combination_of_columns', 1]]);
    expect(filterGaps([ROW, COMBO], 'STATUS', new Set(), gapSubject)).toEqual([COMBO]);
    expect(filterGaps([ROW, COMBO], 'stg', new Set(), gapSubject)).toEqual([ROW]);
    expect(filterGaps([ROW, COMBO], '', new Set(['relationships']), gapSubject)).toEqual([ROW]);
    expect(filterGaps([ROW, COMBO], '', new Set(), gapSubject)).toEqual([ROW, COMBO]);
  });
});

describe('testGapsCardState', () => {
  const base = { locked: false, loading: false, notReady: null, lineageRunning: false, total: 3, failed: false } as const;

  it('counts gaps, or says there are none', () => {
    expect(testGapsCardState(base)).toEqual({ tone: 'warn', headline: '3 columns could use a test', canRefresh: true });
    expect(testGapsCardState({ ...base, total: 1 }).headline).toBe('1 column could use a test');
    expect(testGapsCardState({ ...base, total: 0 })).toEqual({ tone: 'ok', headline: 'No gaps found', canRefresh: true });
  });

  it('waits on column lineage', () => {
    expect(testGapsCardState({ ...base, notReady: 'missing' }).headline).toBe('Needs column lineage');
    expect(testGapsCardState({ ...base, notReady: 'outdated' }).canRefresh).toBe(true);
    expect(testGapsCardState({ ...base, notReady: 'outdated', lineageRunning: true }).tone).toBe('running');
    expect(testGapsCardState({ ...base, notReady: 'error' }).tone).toBe('fail');
  });

  it('is locked without Pro, and loading before the first answer', () => {
    expect(testGapsCardState({ ...base, locked: true, notReady: 'missing' })).toEqual({
      tone: 'idle', headline: 'wickd Pro', canRefresh: false,
    });
    expect(testGapsCardState({ ...base, loading: true, total: null }).headline).toBe('Ranking columns…');
  });
});

describe('testGapsBadge', () => {
  it('shows the count, a dot while lineage runs, nothing otherwise', () => {
    expect(testGapsBadge(7, null)).toEqual({ label: '7', tone: 'warn' });
    expect(testGapsBadge(null, 'running')).toEqual({ label: null, tone: 'running' });
    expect(testGapsBadge(0, null)).toBeNull();
    expect(testGapsBadge(null, 'outdated')).toBeNull();
  });
});

describe('ignored rows', () => {
  it('says whether each is still a gap', () => {
    expect(ignoredStatus({ still_a_gap: true })).toBe('still a gap');
    expect(ignoredStatus({ still_a_gap: false })).toBe('no longer a gap');
    expect(ignoredStatus({ still_a_gap: null })).toBe('unknown — refresh column lineage');
  });
});
