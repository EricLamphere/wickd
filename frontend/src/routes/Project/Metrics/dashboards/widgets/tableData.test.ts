import { describe, expect, it } from 'vitest';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { tableData } from './tableData';

const q = (columns: string[], rows: unknown[][]) => ({ status: 'ok' as const, query: {}, sql: null, columns, rows, truncated: false, ran_at: null, error: null });
const result = (queries: WidgetResultDto['queries'], grain = 'month'): WidgetResultDto => ({
  widget_id: 'w', status: 'ok', error: null, notes: [], grain, current: null, previous: null, ran_at: null, queries,
});
const table = (options: Record<string, unknown>): DashboardWidget => ({ id: 't', type: 'table', width: 50, height: 300, metrics: ['revenue'], options });

describe('tableData', () => {
  it('matches previous rows by dimension values', () => {
    const d = tableData(table({ dimensions: ['region'] }), result({
      current: q(['region', 'revenue'], [['north', 30], ['south', 10]]),
      current_previous: q(['region', 'revenue'], [['south', 20], ['north', 20]]),
    }), new Map([['revenue', 'Revenue']]));
    expect(d.columns).toEqual(['region', 'Revenue', 'Revenue (previous)', 'Revenue change']);
    expect(d.rows).toEqual([['north', 30, 20, '+50%'], ['south', 10, 20, '−50%']]);
    expect(d.keyColumns).toBe(1);
    expect(d.byPeriod).toBe(false);
  });

  it('puts the period first and matches previous periods by position', () => {
    const d = tableData(table({ period_grain: 'auto', dimensions: ['region'] }), result({
      current: q(['metric_time__month', 'region', 'revenue'], [['2026-02-01', 'north', 40], ['2026-01-01', 'north', 30]]),
      current_previous: q(['metric_time__month', 'region', 'revenue'], [['2025-01-01', 'north', 20], ['2025-02-01', 'north', 40]]),
    }), new Map());
    expect(d.columns.slice(0, 3)).toEqual(['month', 'region', 'revenue']);
    expect(d.rows.map((r) => r.slice(1))).toEqual([['north', 40, 40, '0.0%'], ['north', 30, 20, '+50%']]);
    expect(d.keyColumns).toBe(2);
    expect(d.byPeriod).toBe(true);
  });

  it('works without a comparison', () => {
    const d = tableData(table({}), result({ current: q(['revenue'], [[12.345]]) }), new Map());
    expect(d).toEqual({ columns: ['revenue'], rows: [[12.35]], keyColumns: 0, byPeriod: false });
  });
});
