import { describe, expect, it } from 'vitest';
import type { WidgetResultDto } from '../../../../lib/dashboardsApi';
import { drillBodies, drillQuery, drillResult, pickFilters, pickKey, pickLabel, pickStats } from './drill';

const q = (columns: string[], rows: unknown[][], query = {}) => ({ status: 'ok' as const, query, sql: null, columns, rows, truncated: false, ran_at: null, error: null });
const result = (queries: WidgetResultDto['queries']): WidgetResultDto => ({
  widget_id: 'w', status: 'ok', error: null, notes: [], grain: 'week', current: null, previous: null, ran_at: null, queries,
});
const region = { values: [{ dimension: 'customer__region', value: 'north' }] };

describe('drill', () => {
  it('labels and filters picks', () => {
    expect(pickLabel({ values: [{ dimension: 'a', value: 'x' }, { dimension: 'b', value: '∅' }] })).toBe('x · (empty)');
    expect(pickKey(region)).toBe('customer__region=north');
    expect(pickFilters(region)).toEqual(["{{ Dimension('customer__region') }} = 'north'"]);
  });

  it('narrows the query the widget ran and groups it over time', () => {
    const ran = { metrics: ['revenue'], group_by: ['customer__region'], where: ['x'], order_by: ['-revenue'], limit: 5, start: '2026-01-01', end: '2026-01-31' };
    expect(drillQuery(ran, region, 'week')).toEqual({ metrics: ['revenue'], group_by: ['metric_time__week'],
      where: ['x', "{{ Dimension('customer__region') }} = 'north'"], start: '2026-01-01', end: '2026-01-31' });
    const bodies = drillBodies(result({ current: q([], [], ran), current_previous: q([], [], { ...ran, start: '2025-12-01' }) }), region);
    expect(bodies?.current.group_by).toEqual(['metric_time__week']);
    expect(bodies?.previous?.start).toBe('2025-12-01');
    expect(drillBodies(result({ current: q([], [], ran) }), region)?.previous).toBeNull();
    expect(drillBodies(result({ total: q([], []) }), region)).toBeNull();
  });

  it('computes a pick\'s stats', () => {
    const r = result({
      current: q(['customer__region', 'revenue'], [['north', 30], ['south', 70]]),
      current_previous: q(['customer__region', 'revenue'], [['north', 20]]),
    });
    const s = pickStats(r, region, 'revenue');
    expect(s?.value).toBe(30);
    expect(s?.previous).toBe(20);
    expect(s?.change).toBeCloseTo(0.5);
    expect(s?.share).toBeCloseTo(0.3);
    expect(pickStats(r, { values: [{ dimension: 'customer__region', value: 'east' }] }, 'revenue')).toBeNull();
    const t = result({ current: q(['a', 'b', 'm'], [['x', 'y', 5], ['x', 'z', 6]]) });
    expect(pickStats(t, { values: [{ dimension: 'a', value: 'x' }, { dimension: 'b', value: 'z' }] }, 'm')).toEqual({ value: 6, previous: null, change: null, share: null });
  });

  it('wraps drill data as a widget result', () => {
    const base = result({ current: q([], []) });
    const r = drillResult(base, { columns: ['t', 'm'], rows: [[1, 2]] }, null);
    expect(r.queries.current.rows).toEqual([[1, 2]]);
    expect(r.queries.current_previous).toBeUndefined();
    expect(r.grain).toBe('week');
  });
});
