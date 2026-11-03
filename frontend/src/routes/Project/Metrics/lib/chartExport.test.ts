import { describe, expect, it } from 'vitest';
import type { WidgetQueryDto, WidgetResultDto } from '../../../../lib/dashboardsApi';
import { chartCsv, chartFileName, chartQuery, savedQueryName } from './chartExport';

const q = (status: WidgetQueryDto['status'], columns: string[], rows: unknown[][]): WidgetQueryDto => ({
  status, query: { metrics: ['revenue'] }, sql: 'select 1', columns, rows, truncated: false, ran_at: null, error: null,
});
const result = (queries: Record<string, WidgetQueryDto>): WidgetResultDto => ({
  widget_id: 'w', status: 'ok', error: null, notes: [], grain: 'day', current: null, previous: null, ran_at: null, queries,
});

describe('chartExport', () => {
  it("takes the chart's own query, not the comparison", () => {
    const r = result({ current_previous: q('ok', ['a'], [[0]]), current: q('ok', ['day', 'revenue'], [['2026-10-01', 12]]) });
    expect(chartQuery(r)?.columns).toEqual(['day', 'revenue']);
    expect(chartCsv(r)).toBe('day,revenue\n2026-10-01,12');
  });

  it("a summary's total, and nothing when no query ran", () => {
    expect(chartQuery(result({ trend: q('ok', ['t'], []), total: q('ok', ['revenue'], [[5]]) }))?.columns).toEqual(['revenue']);
    expect(chartCsv(result({ current: q('not_run', [], []) }))).toBeNull();
    expect(chartCsv(null)).toBeNull();
  });

  it('names the file after the metric, the chart and the day', () => {
    expect(chartFileName(['Revenue', 'Top 10 by customer__country'], new Date(2026, 10, 2))).toBe('revenue-top-10-by-customer-country-20261102');
    expect(chartFileName([''], new Date(2026, 0, 5))).toBe('chart-20260105');
  });

  it("suggests a saved query's name from its metrics and group-bys", () => {
    expect(savedQueryName({ metrics: ['revenue'], group_by: ['metric_time__week'] })).toBe('revenue_by_week');
    expect(savedQueryName({ metrics: ['revenue', 'orders'], group_by: ['customer__country'] })).toBe('revenue_orders_by_country');
    expect(savedQueryName({ metrics: ['Gross-Margin %'] })).toBe('gross_margin');
    expect(savedQueryName({})).toBe('saved_query');
  });
});
