import { describe, expect, it } from 'vitest';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import type { MetricNoteDto } from '../../../../../lib/notesApi';
import { dashboardNotes, exportNoteLine, widgetNoteContext } from './widgetNotes';

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

const note = (over: Partial<MetricNoteDto>): MetricNoteDto => ({
  slug: 'n', path: 'p', title: 'N', start: '2026-11-03', end: '2026-11-03', metrics: [], dimension: null, value: null,
  created: null, body: '', error: null, warnings: [], modified_at: null, tags: [], type: 'note', status: null, resolved: null, recurs: null,
  widget: null, source: null, models: [], commits: [], links: [], ...over,
});

describe('dashboardNotes', () => {
  it('lists each note shown on any widget once, by date', () => {
    const notes = [
      note({ slug: 'b', title: 'B', start: '2026-11-10', end: '2026-11-10' }),
      note({ slug: 'a', title: 'A', metrics: ['revenue'], dimension: 'region', value: 'EU' }),
      note({ slug: 'us', dimension: 'region', value: 'US' }),
      note({ slug: 'orders', metrics: ['orders'] }),
      note({ slug: 'later', start: '2027-01-01', end: '2027-01-01' }),
    ];
    const two = [widget, { ...widget, id: 'w2' }];
    const results = [result, { ...result, widget_id: 'w2' }];
    expect(dashboardNotes(two, results, notes).map((n) => n.slug)).toEqual(['a', 'b']);
  });
  it('writes one line per note', () => {
    expect(exportNoteLine(note({ title: 'Outage', end: '2026-11-04', metrics: ['revenue'], type: 'incident', status: 'open' })))
      .toBe('2026-11-03 – 2026-11-04 · Outage · revenue · open incident');
    expect(exportNoteLine(note({ title: 'Xmas', recurs: 'yearly' }))).toBe('2026-11-03 (every year) · Xmas · every metric');
  });
});
