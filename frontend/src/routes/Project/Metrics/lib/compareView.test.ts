import { describe, expect, it } from 'vitest';
import type { CompareResultDto } from '../../../../lib/semanticApi';
import { compareFields, compareSeries, compareUrl, differencesTable, readCompare, sideLabel, sideNames, writeCompare } from './compareView';
import { readExploreWidget } from './exploreWidget';

const side = (over = {}) => ({ ref: null, sha: null, target: null, query: {}, sql: 's', columns: [], rows: [], truncated: false, error: null, missing: false, ...over });
const value = (current: number | null, base: number | null) => ({
  current, base, delta: current !== null && base !== null ? current - base : null,
  pct: current !== null && base ? (current - base) / base : null, changed: current !== base,
});
const result = (over: Partial<CompareResultDto> = {}): CompareResultDto => ({
  mode: 'working', metrics: ['revenue'], other_metric: null, active_target: 'dev',
  current: side(), base: side({ ref: 'HEAD', sha: 'abc1234def' }),
  diff: {
    key_columns: ['metric_time__day'],
    rows: [
      { key: ['2026-01-02'], status: 'same', values: { revenue: value(5, 5) } },
      { key: ['2026-01-01'], status: 'changed', values: { revenue: value(12, 10) } },
      { key: ['2026-01-03'], status: 'only_base', values: { revenue: value(null, 3) } },
    ],
    summary: { total: 3, same: 1, changed: 1, only_current: 0, only_base: 1, headline: 'h', largest: [], by_dimension: [], shape: 'localized' },
    sql_diff: '',
  },
  notes: [],
  ...over,
});

describe('compareView', () => {
  it('keeps the compare state in the URL', () => {
    const params = writeCompare(new URLSearchParams('tab=explore&view=query'), { mode: 'branch', base: 'main' });
    expect(params.get('cmp')).toBe('branch');
    expect(readCompare(params)).toEqual({ mode: 'branch', base: 'main' });
    expect(readCompare(writeCompare(params, null))).toBeNull();
    expect(readCompare(new URLSearchParams('cmp=nonsense'))).toBeNull();
    expect(writeCompare(new URLSearchParams(), { mode: 'working', base: '' }).has('cmp_base')).toBe(false);
  });

  it('sends the base as the field its mode needs', () => {
    expect(compareFields({ mode: 'branch', base: ' main ' })).toEqual({ base_ref: 'main' });
    expect(compareFields({ mode: 'targets', base: 'prod' })).toEqual({ base_target: 'prod' });
    expect(compareFields({ mode: 'metrics', base: 'revenue_v2' })).toEqual({ other_metric: 'revenue_v2' });
    expect(compareFields({ mode: 'working', base: 'x' })).toEqual({});
    expect(compareFields({ mode: 'targets', base: '' })).toEqual({});
  });

  it('labels both sides', () => {
    expect(sideLabel(result(), 'current', undefined)).toBe('Now, uncommitted · dev');
    expect(sideLabel(result(), 'base', undefined)).toBe('HEAD abc1234 · dev');
    const branch = result({ mode: 'branch', base: side({ ref: 'main', sha: '1a2b3c4d', target: 'prod' }) });
    expect(sideLabel(branch, 'base', undefined)).toBe('main (merge base 1a2b3c4) · prod');
    const metrics = result({ mode: 'metrics', other_metric: 'revenue_v2' });
    expect(sideLabel(metrics, 'current', undefined)).toBe('revenue · Now · dev');
    expect(sideLabel(metrics, 'base', undefined)).toBe('revenue_v2 · dev');
    expect(sideLabel(metrics, 'base', undefined, new Map([['revenue_v2', 'Revenue v2']]))).toBe('Revenue v2 · dev');
  });

  it('lists the differences first', () => {
    const t = differencesTable(result(), new Map([['revenue', 'Revenue']]), false);
    expect(t.columns).toEqual(['metric_time__day', 'Revenue now', 'Revenue before', 'Revenue Δ', 'Revenue Δ%', 'status']);
    expect(t.rows.map((r) => r[0])).toEqual(['2026-01-01', '2026-01-03', '2026-01-02']);
    expect(t.rows[0]).toEqual(['2026-01-01', 12, 10, 2, '+20%', 'changed']);
    expect(differencesTable(result(), new Map(), true).rows).toHaveLength(2);
    expect(t.rows[1][5]).toBe('only before');
    // two metrics: each side's column is that metric's
    const labels = new Map([['revenue', 'Total Orders'], ['orders', 'Orders']]);
    const m = differencesTable(result({ mode: 'metrics', other_metric: 'orders' }), labels, false);
    expect(m.columns).toEqual(['metric_time__day', 'Total Orders', 'Orders', 'Δ', 'Δ%', 'status']);
    expect(m.rows[1][5]).toBe('only Orders');
    expect(sideNames(result({ mode: 'metrics', other_metric: 'orders' }), labels)).toEqual({ current: 'Total Orders', base: 'Orders' });
    expect(sideNames(result(), labels)).toEqual({ current: 'now', base: 'before' });
    expect(differencesTable(result({ diff: null }), new Map(), false).rows).toEqual([]);
  });

  it('puts both sides on one series', () => {
    const s = compareSeries(result(), 'revenue');
    expect(s.time).toBe(true);
    expect(s.points.map((p) => [p.current, p.base])).toEqual([[12, 10], [5, 5], [null, 3]]);
    const byRegion = result({ diff: { ...result().diff!, key_columns: ['customer__region'],
      rows: [{ key: ['north'], status: 'changed', values: { revenue: value(1, 2) } }, { key: [null], status: 'same', values: { revenue: value(9, 9) } }] } });
    expect(compareSeries(byRegion, 'revenue').points.map((p) => p.x)).toEqual(['∅', 'north']);
  });

  it('links to the explorer comparing a metric', () => {
    const url = compareUrl(3, 'revenue', { mode: 'branch', base: 'main' });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(url.startsWith('/projects/3/metrics?')).toBe(true);
    expect(params.get('tab')).toBe('explore');
    expect(readCompare(params)).toEqual({ mode: 'branch', base: 'main' });
    expect(readExploreWidget(params)?.metrics).toEqual(['revenue']);
  });
});
