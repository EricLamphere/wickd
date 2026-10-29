import { describe, expect, it } from 'vitest';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { barShape, MAX_STACKS } from './barShape';

const q = (columns: string[], rows: unknown[][]) => ({ status: 'ok' as const, query: {}, sql: null, columns, rows, truncated: false, ran_at: null, error: null });
const result = (queries: WidgetResultDto['queries']): WidgetResultDto => ({
  widget_id: 'w', status: 'ok', error: null, notes: [], grain: 'day', current: null, previous: null, ran_at: null, queries,
});
const bar = (options: Record<string, unknown>, metrics = ['revenue']): DashboardWidget => ({ id: 'b', type: 'bar', width: 50, height: 300, metrics, options });
const cols = ['region', 'channel', 'revenue'];

describe('barShape', () => {
  it('stacks the current and the previous period side by side, matched by bar and stack', () => {
    const shaped = barShape(bar({ dimension: 'region', stack_by: 'channel' }), result({
      current: q(cols, [['north', 'web', 30], ['north', 'store', 10], ['south', 'web', 5]]),
      current_previous: q(cols, [['north', 'web', 20], ['south', 'store', 7]]),
    }), ['revenue'], new Map());
    expect(shaped.stacked).toBe(true);
    expect(shaped.series.map((s) => [s.key, s.stack, s.stackId, s.previous ?? false])).toEqual([
      ['s0', 'web', 'current', false], ['s1', 'store', 'current', false],
      ['p0', 'web', 'previous', true], ['p1', 'store', 'previous', true],
    ]);
    expect(shaped.series[2].color).toBe(shaped.series[0].color);
    expect(shaped.rows).toEqual([
      { x: 'north', s0: 30, s1: 10, p0: 20, p1: null },
      { x: 'south', s0: 5, s1: null, p0: null, p1: 7 },
    ]);
    expect(shaped.legend.map((l) => l.label)).toEqual(['web', 'store', 'Previous period']);
  });

  it('draws stacks without a comparison when there is none', () => {
    const shaped = barShape(bar({ dimension: 'region', stack_by: 'channel' }), result({ current: q(cols, [['north', 'web', 1]]) }), ['revenue'], new Map());
    expect(shaped.series.map((s) => s.key)).toEqual(['s0']);
    expect(shaped.legend.map((l) => l.label)).toEqual(['web']);
  });

  it('keeps the top N bars and the largest stacks', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ['north', `c${i}`, i + 1]).concat([['south', 'c0', 1], ['east', 'c0', 100]]);
    const shaped = barShape(bar({ dimension: 'region', stack_by: 'channel', top_n: 2 }), result({ current: q(cols, rows) }), ['revenue'], new Map());
    expect(shaped.rows.map((r) => r.x)).toEqual(['east', 'north']);
    expect(shaped.series).toHaveLength(MAX_STACKS);
  });

  it('draws plain bars with gray previous bars per metric', () => {
    const shaped = barShape(bar({ dimension: 'region' }, ['revenue', 'orders']), result({
      current: q(['region', 'revenue', 'orders'], [['north', 30, 3]]),
      current_previous: q(['region', 'revenue', 'orders'], [['north', 20, 2]]),
    }), ['revenue', 'orders'], new Map([['revenue', 'Revenue']]));
    expect(shaped.stacked).toBe(false);
    expect(shaped.series.map((s) => s.label)).toEqual(['Revenue', 'Revenue (previous)', 'orders', 'orders (previous)']);
    expect(shaped.rows).toEqual([{ x: 'north', m0: 30, p0: 20, m1: 3, p1: 2 }]);
  });
});
