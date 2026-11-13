// Metric query runs in flight (backend semantic/query_control.py): the list from
// GET …/semantic/queries/active, kept current by `metric_queries_progress` events. Pure, tested.
import type { MetricQueryRunDto } from '../../../../lib/semanticApi';

export type RunKind = MetricQueryRunDto['kind'];

/** The runs after one progress event: a finished run leaves the list, any other replaces its entry. */
export function applyProgress(runs: MetricQueryRunDto[], event: MetricQueryRunDto): MetricQueryRunDto[] {
  const others = runs.filter((r) => r.run_id !== event.run_id);
  return event.finished ? others : [...others, event];
}

/** Whether a progress event's payload looks like a run (events are untrusted JSON). */
export function isRunEvent(data: unknown): data is MetricQueryRunDto {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.run_id === 'string' && typeof d.done === 'number' && typeof d.total === 'number';
}

export interface ActivitySummary {
  runIds: string[];
  done: number;
  total: number;
  cancelling: boolean;
}

/** The runs of `kinds` (all when omitted) added up, or null when none is running. */
export function summarize(runs: MetricQueryRunDto[], kinds?: readonly RunKind[]): ActivitySummary | null {
  const picked = kinds ? runs.filter((r) => kinds.includes(r.kind)) : runs;
  if (!picked.length) return null;
  return {
    runIds: picked.map((r) => r.run_id),
    done: picked.reduce((n, r) => n + r.done, 0),
    total: picked.reduce((n, r) => n + r.total, 0),
    cancelling: picked.every((r) => r.cancelled),
  };
}

/** "45 / 380 queries" (or "1 query" for a single one still running). */
export function progressText(summary: ActivitySummary): string {
  if (summary.total <= 1) return '1 query';
  return `${summary.done.toLocaleString()} / ${summary.total.toLocaleString()} queries`;
}

/** Read stored results again this often while a run is going (each read re-explains every query). */
export const PROGRESS_REFRESH_MS = 3000;

/** Whether a `metric_queries_progress` event should refresh the metric index / pages now: a run of
 *  theirs (`metrics` / `explore`) made progress, and the last refresh was PROGRESS_REFRESH_MS ago. */
export function progressRefresh(data: unknown, lastAt: number, now: number): boolean {
  if (!isRunEvent(data) || data.finished || data.done === 0) return false;
  if (data.kind !== 'metrics' && data.kind !== 'explore') return false;
  return now - lastAt >= PROGRESS_REFRESH_MS;
}
