import { describe, expect, it } from 'vitest';
import type { SourceFreshnessResult } from '../../../lib/api';
import { errorThresholdRatio, isApproachingWarn, periodSeconds, sortByUrgency } from './freshnessUrgency';

const src = (over: Partial<SourceFreshnessResult>): SourceFreshnessResult => ({
  unique_id: 'source.p.s.t', source_name: 's', table_name: 't', status: 'pass',
  max_loaded_at: null, snapshotted_at: null, age_seconds: null,
  warn_after_count: null, warn_after_period: null, error_after_count: null, error_after_period: null,
  error: null, ...over,
});

describe('periodSeconds', () => {
  it('converts dbt freshness periods', () => {
    expect(periodSeconds(2, 'hour')).toBe(7200);
    expect(periodSeconds(1, 'day')).toBe(86_400);
    expect(periodSeconds(30, 'minute')).toBe(1800);
    expect(periodSeconds(null, 'hour')).toBeNull();
    expect(periodSeconds(1, 'fortnight')).toBeNull();
  });
});

describe('errorThresholdRatio', () => {
  it('is age over the error threshold, falling back to warn', () => {
    expect(errorThresholdRatio(src({ age_seconds: 3600, error_after_count: 2, error_after_period: 'hour' }))).toBe(0.5);
    expect(errorThresholdRatio(src({ age_seconds: 3600, warn_after_count: 1, warn_after_period: 'hour' }))).toBe(1);
    expect(errorThresholdRatio(src({ age_seconds: null, error_after_count: 1, error_after_period: 'hour' }))).toBeNull();
  });
});

describe('isApproachingWarn', () => {
  it('flags passing sources at 75%+ of their warn threshold', () => {
    const t = { warn_after_count: 4, warn_after_period: 'hour' };
    expect(isApproachingWarn(src({ ...t, age_seconds: 3 * 3600 }))).toBe(true);
    expect(isApproachingWarn(src({ ...t, age_seconds: 3600 }))).toBe(false);
    expect(isApproachingWarn(src({ ...t, age_seconds: 3 * 3600, status: 'warn' }))).toBe(false);
  });
});

describe('sortByUrgency', () => {
  it('orders by status, then by how close each is to its error threshold', () => {
    const h = { error_after_count: 10, error_after_period: 'hour' };
    const rows = [
      src({ table_name: 'calm', ...h, age_seconds: 3600 }),
      src({ table_name: 'unknown' }),
      src({ table_name: 'close', ...h, age_seconds: 9 * 3600 }),
      src({ table_name: 'warned', status: 'warn', ...h, age_seconds: 5 * 3600 }),
      src({ table_name: 'broken', status: 'runtime error' }),
    ];
    expect(sortByUrgency(rows).map((r) => r.table_name)).toEqual(['broken', 'warned', 'close', 'calm', 'unknown']);
    expect(rows[0].table_name).toBe('calm'); // input untouched
  });
});
