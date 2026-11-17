// What a dashboard widget shows, as a note context: its metrics, the dates it ran for (its
// current period) and the dimension values its filters pin (the dashboard's filters are in the
// query it ran). Pure; tested in widgetNotes.test.ts.
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { pinnedDims } from './metricNotes';

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
