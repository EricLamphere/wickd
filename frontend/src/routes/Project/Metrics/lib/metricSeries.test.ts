import { describe, expect, it } from 'vitest';
import { MAX_SERIES, buildPanels, formatTime, formatValue, isIsolated, parseTime, seriesColor } from './metricSeries';

const DAY = 86_400_000;
const JAN1 = Date.UTC(2026, 0, 1);

describe('parseTime', () => {
  it('reads dates and naive timestamps as UTC', () => {
    expect(parseTime('2026-01-01')).toBe(JAN1);
    expect(parseTime('2026-01-01 00:00:00')).toBe(JAN1);
    expect(parseTime('2026-01-01T00:00:00')).toBe(JAN1);
    expect(parseTime('2026-01-01T01:00:00+01:00')).toBe(JAN1);
    expect(parseTime(null)).toBeNull();
    expect(parseTime('nope')).toBeNull();
  });
});

describe('buildPanels', () => {
  it('makes one line panel per metric (small multiples), sorted by time', () => {
    const rows = [['2026-01-02', 5, 0.5], ['2026-01-01', 3, 0.25]];
    const panels = buildPanels(['metric_time__day', 'revenue', 'aov'], rows,
      { metrics: ['revenue', 'aov'], timeColumn: 'metric_time__day', dimensionColumns: [], labels: { revenue: 'Revenue' } });
    expect(panels.map((p) => [p.metric, p.label, p.kind])).toEqual([['revenue', 'Revenue', 'line'], ['aov', 'aov', 'line']]);
    expect(panels[0].data).toEqual([{ x: JAN1, s0: 3 }, { x: JAN1 + DAY, s0: 5 }]);
    expect(panels[0].series).toEqual([{ key: 's0', label: 'Revenue', color: 'var(--series-1)' }]);
  });

  it('splits a time series by dimension value: top N by total, the rest counted, gaps as null', () => {
    const values = Array.from({ length: MAX_SERIES + 2 }, (_, i) => `c${i}`);
    const rows = values.flatMap((v, i) => [['2026-01-01', v, 100 - i], ...(i === 0 ? [] : [['2026-01-02', v, 1]])]);
    const [panel] = buildPanels(['metric_time__day', 'country', 'revenue'], rows,
      { metrics: ['revenue'], timeColumn: 'metric_time__day', dimensionColumns: ['country'] });
    expect(panel.series).toHaveLength(MAX_SERIES);
    expect(panel.series[0]).toEqual({ key: 's0', label: 'c0', color: 'var(--series-1)' });
    expect(panel.hiddenSeries).toBe(2);
    expect(panel.data[1]).toMatchObject({ x: JAN1 + DAY, s0: null, s1: 1 });
  });

  it('draws categorical group-bys as bars, largest first, grouped by a second dimension', () => {
    const rows = [['web', 'US', 2], ['mobile', 'US', 5], ['web', 'CA', 1]];
    const [panel] = buildPanels(['channel', 'country', 'orders'], rows,
      { metrics: ['orders'], timeColumn: null, dimensionColumns: ['channel', 'country'] });
    expect(panel.kind).toBe('bar');
    expect(panel.series.map((s) => s.label)).toEqual(['US', 'CA']);
    expect(panel.data).toEqual([{ x: 'mobile', s0: 5, s1: null }, { x: 'web', s0: 2, s1: 1 }]);
  });

  it('is a KPI with no group-bys, and skips metrics missing from the result', () => {
    const panels = buildPanels(['revenue'], [['12.5']], { metrics: ['revenue', 'missing'], timeColumn: null, dimensionColumns: [] });
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ kind: 'kpi', value: 12.5 });
  });
});

describe('formatting', () => {
  it('formats values and time ticks', () => {
    expect(formatValue(12_345)).toMatch(/12\.3K/i);
    expect(formatValue(0.01234)).toBe('0.0123');
    expect(formatValue(null)).toBe('–');
    expect(formatTime(JAN1, 'quarter')).toBe('Q1 2026');
    expect(formatTime(JAN1, 'month')).toBe('Jan 2026');
    expect(formatTime(JAN1, 'day')).toBe('Jan 1, 2026');
    expect(seriesColor(MAX_SERIES)).toBe('var(--series-1)');
  });
});

describe('isIsolated', () => {
  it('flags values with gaps on both sides', () => {
    const data = [{ x: 1, a: 1 }, { x: 2, a: null }, { x: 3, a: 2 }, { x: 4, a: 3 }];
    expect([0, 1, 2, 3].map((i) => isIsolated(data, 'a', i))).toEqual([true, false, false, false]);
  });
});

describe('shared series order', () => {
  it('keeps a dimension value on the same colour in every panel', () => {
    const rows = [['2026-01-01', 'US', 10, 1], ['2026-01-01', 'CA', 1, 9]];
    const [revenue, orders] = buildPanels(['metric_time__day', 'country', 'revenue', 'orders'], rows,
      { metrics: ['revenue', 'orders'], timeColumn: 'metric_time__day', dimensionColumns: ['country'] });
    expect(revenue.series.map((s) => s.label)).toEqual(['US', 'CA']);
    expect(orders.series.map((s) => s.label)).toEqual(['US', 'CA']);
  });
});
