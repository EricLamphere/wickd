// The widget a note is about (plan 33): saved in the note's frontmatter as the query view's widget
// encoding (lib/exploreWidget.ts) with the dates it showed pinned, so the note can show it again
// and open it "as it was". Pure; tested in noteWidget.test.ts.
import type { ComparePeriod, DashboardWidget, WidgetType } from '../../../../../lib/dashboardsApi';
import type { MetricQueryBody } from '../../../../../lib/semanticApi';
import { EXPLORE_ID, emptyExploreWidget, exploreFromDashboard } from '../../lib/exploreWidget';

const TYPE_LABELS: Record<WidgetType, string> = {
  summary: 'Summary', timeseries: 'Time series', bar: 'Bar chart', table: 'Table', leaderboard: 'Leaderboard', text: 'Text',
};
/** How tall the note shows its widget (px). */
export const NOTE_WIDGET_HEIGHT = 200;

/** The widget as saved with a note: the dates it ran for pinned, no id or size. */
export function noteWidgetOf(widget: DashboardWidget, ran?: MetricQueryBody, compare?: ComparePeriod): Record<string, unknown> | null {
  if (widget.type === 'text' || !widget.metrics?.length) return null;
  const { id: _id, width: _w, height: _h, ...rest } = exploreFromDashboard(widget, ran, compare);
  return rest;
}

/** A saved widget back as a widget to draw (the explorer's id; the note's height). */
export function widgetFromNote(saved: Record<string, unknown>): DashboardWidget | null {
  if (typeof saved.type !== 'string' || !(saved.type in TYPE_LABELS) || saved.type === 'text') return null;
  return { ...emptyExploreWidget(), ...saved, id: EXPLORE_ID, width: 100, height: NOTE_WIDGET_HEIGHT } as DashboardWidget;
}

/** "Time series of revenue, orders (2026-11-01 – 2026-11-30)" */
export function widgetSummary(saved: Record<string, unknown>): string {
  const type = TYPE_LABELS[saved.type as WidgetType] ?? String(saved.type ?? 'Widget');
  const metrics = Array.isArray(saved.metrics) ? saved.metrics.map(String) : [];
  const current = (saved.period as { current?: unknown } | undefined)?.current;
  const dates = current && typeof current === 'object' && 'start' in current && 'end' in current
    ? ` (${String((current as { start: string }).start)} – ${String((current as { end: string }).end)})` : '';
  return `${type}${metrics.length ? ` of ${metrics.join(', ')}` : ''}${dates}`;
}

/** The Metrics page's query view showing the saved widget. */
export function noteWidgetUrl(projectId: number, saved: Record<string, unknown>): string {
  const { id: _id, width: _w, height: _h, ...rest } = saved;
  const params = new URLSearchParams({ tab: 'explore', view: 'query', w: JSON.stringify(rest) });
  return `/projects/${projectId}/metrics?${params.toString()}`;
}
