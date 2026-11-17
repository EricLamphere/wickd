// Opening the New note dialog, or a note, from anywhere (dashboards, monitors, metric pages, the
// metrics sidebar, Files): NoteHost (mounted once in ProjectLayout) listens for these, so entry
// points only dispatch an event (same pattern as lib/refactorEvents.ts).
import { prefillFrom, type NoteEntry, type NotePrefill } from './lib/metricNotes';

export const ADD_METRIC_NOTE_EVENT = 'wickd:add-metric-note';
export const OPEN_METRIC_NOTE_EVENT = 'wickd:open-metric-note';

export interface AddNoteDetail {
  prefill: NotePrefill;
  /** Mark as expected → note: link the saved note to this log entry */
  expectationId?: number | null;
  /** shown above the form (e.g. why it opened after Mark as expected) */
  intro?: string | null;
  /** offer "Don't ask again" (Mark as expected); checking it calls this */
  onDontAsk?: (() => void) | null;
}

export interface OpenNoteDetail {
  slug: string;
  edit?: boolean;
}

export function addMetricNote(entry: NoteEntry | NotePrefill, extra: Omit<AddNoteDetail, 'prefill'> = {}): void {
  const prefill = 'kind' in entry ? prefillFrom(entry) : entry;
  window.dispatchEvent(new CustomEvent<AddNoteDetail>(ADD_METRIC_NOTE_EVENT, { detail: { prefill, ...extra } }));
}

export function openMetricNote(slug: string, edit = false): void {
  window.dispatchEvent(new CustomEvent<OpenNoteDetail>(OPEN_METRIC_NOTE_EVENT, { detail: { slug, edit } }));
}
