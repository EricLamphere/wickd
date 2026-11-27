// What a dashboard widget shows, as a note context: its metrics, the dates it ran for (its
// current period) and the dimension values its filters pin (the dashboard's filters are in the
// query it ran). Pure; tested in widgetNotes.test.ts.
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import type { MetricNoteDto } from '../../../../../lib/notesApi';
import { notesFor, pinnedDims, rangeText } from './metricNotes';

export interface WidgetNoteContext {
  start: string;
  end: string;
  metrics: string[];
  dims: Record<string, string>;
}

export function widgetNoteContext(widget: DashboardWidget, result: WidgetResultDto | null | undefined): WidgetNoteContext | null {
  if (widget.type === 'text' || !widget.metrics?.length) return null;
  const range = result?.current;
  if (!range) return null;
  const where = result?.queries?.current?.query?.where ?? widget.filters ?? [];
  return { start: range.start, end: range.end, metrics: [...widget.metrics], dims: pinnedDims(where) };
}

/** Every note shown on a dashboard (on any widget), in date order, once each (plan 33: exports list them). */
export function dashboardNotes(widgets: readonly DashboardWidget[], results: readonly WidgetResultDto[], notes: readonly MetricNoteDto[]): MetricNoteDto[] {
  const byId = new Map(results.map((r) => [r.widget_id, r]));
  const found = new Map<string, MetricNoteDto>();
  for (const w of widgets) {
    const ctx = widgetNoteContext(w, byId.get(w.id));
    if (!ctx) continue;
    for (const n of notesFor(notes.filter((x) => !x.error), ctx)) found.set(n.slug, n);
  }
  return [...found.values()].sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.title.localeCompare(b.title));
}

/** One line per note for an export: "2026-11-03 – 2026-11-04 · EU checkout outage · revenue · open incident". */
export function exportNoteLine(n: MetricNoteDto): string {
  return [
    rangeText(n.start, n.end) + (n.recurs === 'yearly' ? ' (every year)' : ''),
    n.title,
    n.metrics.length ? n.metrics.join(', ') : 'every metric',
    n.dimension ? `${n.dimension} = ${n.value}` : null,
    n.type === 'release' ? 'release' : n.type === 'incident' ? (n.status === 'resolved' ? 'resolved incident' : 'open incident') : null,
  ].filter(Boolean).join(' · ');
}
