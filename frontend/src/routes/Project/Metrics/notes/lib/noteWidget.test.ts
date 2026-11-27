import { describe, expect, it } from 'vitest';
import type { DashboardWidget } from '../../../../../lib/dashboardsApi';
import { noteWidgetOf, noteWidgetUrl, widgetFromNote, widgetSummary } from './noteWidget';

const widget: DashboardWidget = { id: 'w3', type: 'timeseries', width: 50, height: 300, metrics: ['revenue'], period: { current: 'last_30_days' } };

describe('noteWidget', () => {
  it('saves the widget with the dates it ran for, without id or size', () => {
    const saved = noteWidgetOf(widget, { metrics: ['revenue'], start: '2026-11-01', end: '2026-11-30', where: ["x = 'y'"] } as never);
    expect(saved).toMatchObject({ type: 'timeseries', metrics: ['revenue'], filters: ["x = 'y'"], period: { current: { start: '2026-11-01', end: '2026-11-30' } } });
    expect(saved).not.toHaveProperty('id');
    expect(saved).not.toHaveProperty('width');
    expect(noteWidgetOf({ ...widget, type: 'text' })).toBeNull();
    expect(noteWidgetOf({ ...widget, metrics: [] })).toBeNull();
  });
  it('summarises and draws it again', () => {
    const saved = { type: 'bar', metrics: ['revenue', 'orders'], period: { current: { start: '2026-11-01', end: '2026-11-30' } } };
    expect(widgetSummary(saved)).toBe('Bar chart of revenue, orders (2026-11-01 – 2026-11-30)');
    expect(widgetFromNote(saved)).toMatchObject({ type: 'bar', height: 200, id: 'explore' });
    expect(widgetFromNote({ type: 'weird' })).toBeNull();
  });
  it('links to the query view', () => {
    const url = noteWidgetUrl(4, { type: 'summary', metrics: ['revenue'] });
    const params = new URL(url, 'http://x').searchParams;
    expect(url.startsWith('/projects/4/metrics?')).toBe(true);
    expect(params.get('view')).toBe('query');
    expect(JSON.parse(params.get('w')!)).toEqual({ type: 'summary', metrics: ['revenue'] });
  });
});
