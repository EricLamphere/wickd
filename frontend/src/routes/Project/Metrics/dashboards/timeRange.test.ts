import { describe, expect, it } from 'vitest';
import { inRange, periodLastDay, rangeBetween, zoomedIndexes } from './timeRange';

const day = (s: string) => Date.parse(`${s}T00:00:00Z`);

describe('periodLastDay', () => {
  it('ends each grain on its last day', () => {
    expect(periodLastDay(day('2026-03-02'), 'day')).toBe(day('2026-03-02'));
    expect(periodLastDay(day('2026-03-02'), 'week')).toBe(day('2026-03-08'));
    expect(periodLastDay(day('2026-02-01'), 'month')).toBe(day('2026-02-28'));
    expect(periodLastDay(day('2026-04-01'), 'quarter')).toBe(day('2026-06-30'));
    expect(periodLastDay(day('2026-01-01'), 'year')).toBe(day('2026-12-31'));
  });

  it('drops the time of day for hourly points', () => {
    expect(periodLastDay(day('2026-03-02') + 5 * 3_600_000, 'hour')).toBe(day('2026-03-02'));
  });
});

describe('rangeBetween', () => {
  it('covers whole periods, in either order', () => {
    expect(rangeBetween(day('2026-03-01'), day('2026-01-01'), 'month')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(rangeBetween(day('2026-03-05'), day('2026-03-05'), 'day')).toEqual({ start: '2026-03-05', end: '2026-03-05' });
  });
});

describe('zoomedIndexes', () => {
  const xs = [day('2026-01-01'), day('2026-02-01'), day('2026-03-01'), day('2026-04-01')];

  it('keeps the points inside the range', () => {
    expect(zoomedIndexes(xs, { start: '2026-02-01', end: '2026-03-31' })).toEqual([1, 2]);
    expect(inRange(xs[3], { start: '2026-02-01', end: '2026-03-31' })).toBe(false);
  });

  it('keeps every point without a range or when none is inside', () => {
    expect(zoomedIndexes(xs, null)).toEqual([0, 1, 2, 3]);
    expect(zoomedIndexes(xs, { start: '2030-01-01', end: '2030-02-01' })).toEqual([0, 1, 2, 3]);
  });
});
