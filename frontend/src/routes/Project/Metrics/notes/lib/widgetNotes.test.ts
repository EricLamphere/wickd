import { describe, expect, it } from 'vitest';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { widgetNoteContext } from './widgetNotes';

const widget: DashboardWidget = { id: 'w', type: 'summary', width: 50, height: 200, metrics: ['revenue'], filters: [] };
const result = {
  widget_id: 'w', status: 'ok', error: null, notes: [], grain: 'day', current: { start: '2026-11-01', end: '2026-11-30' }, previous: null,
  ran_at: null, queries: { current: { status: 'ok', query: { metrics: ['revenue'], where: ["{{ Dimension('order__region') }} = 'EU'"] },
    sql: null, columns: [], rows: [], truncated: false, ran_at: null, error: null } },
} as unknown as WidgetResultDto;

describe('widgetNoteContext', () => {
  it('reads the period, metrics and the filters the query ran with', () => {
    expect(widgetNoteContext(widget, result)).toEqual({ start: '2026-11-01', end: '2026-11-30', metrics: ['revenue'], dims: { order__region: 'EU' } });
  });
  it('is null for text widgets, widgets without a metric, and before results', () => {
    expect(widgetNoteContext({ ...widget, type: 'text' }, result)).toBeNull();
    expect(widgetNoteContext({ ...widget, metrics: [] }, result)).toBeNull();
    expect(widgetNoteContext(widget, null)).toBeNull();
  });
});
