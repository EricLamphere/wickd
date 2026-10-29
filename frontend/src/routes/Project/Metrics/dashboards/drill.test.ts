import { describe, expect, it } from 'vitest';
import type { WidgetResultDto } from '../../../../lib/dashboardsApi';
import {
  breakdownDimension, drilledWidgets, drillBodies, drillQuery, drillResult, pickFilters, pickKey, pickLabel, withUniqueIds,
} from './drill';

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

  it('wraps drill data as a widget result', () => {
    const base = result({ current: q([], []) });
    const r = drillResult(base, { columns: ['t', 'm'], rows: [[1, 2]] }, null);
    expect(r.queries.current.rows).toEqual([[1, 2]]);
    expect(r.queries.current_previous).toBeUndefined();
    expect(r.grain).toBe('week');
  });

  it('drafts the drilled widgets filtered to the pick', () => {
    const source = { id: 'rev', type: 'bar' as const, width: 50, height: 300, metrics: ['revenue'], filters: ['f'],
      period: { compare: 'none' as const }, options: { dimension: 'customer__region', format: 'currency', top_n: 5 } };
    const labels = new Map([['revenue', 'Revenue']]);
    const drafts = drilledWidgets(source, region, ['summary', 'breakdown', 'table'], 'product__category', labels);
    expect(drafts.summary).toMatchObject({ id: 'revenue_summary', type: 'summary', title: 'Revenue · north', metrics: ['revenue'],
      filters: ['f', "{{ Dimension('customer__region') }} = 'north'"], period: { compare: 'none' }, options: { format: 'currency' } });
    expect(drafts.breakdown).toMatchObject({ id: 'revenue_breakdown', type: 'bar', title: 'Revenue · north by product__category',
      options: { format: 'currency', dimension: 'product__category', top_n: 15, orientation: 'horizontal' } });
    expect(drafts.table).toMatchObject({ id: 'revenue_table', type: 'table', title: 'Revenue · north by period', options: { period_grain: 'auto' } });
    expect(drilledWidgets(source, region, ['breakdown'], null, labels)).toEqual({});
  });

  it('gives widgets ids free on the dashboard', () => {
    const w = (id: string) => ({ id, type: 'summary' as const, width: 25, height: 200 });
    expect(withUniqueIds([w('a'), w('a'), w('b')], ['a']).map((x) => x.id)).toEqual(['a_2', 'a_3', 'b']);
  });

  it('breaks down by the first dimension no filter uses', () => {
    const dims = ['customer__region', 'customer__tier', 'product__category'];
    const filters = ["{{ Dimension('customer__region') }} = 'north'", "{{ Dimension('customer__tier') }} in ('gold')"];
    expect(breakdownDimension(dims, filters)).toBe('product__category');
    expect(breakdownDimension(dims, [])).toBe('customer__region');
    expect(breakdownDimension(['customer__region'], filters)).toBeNull();
  });
});
