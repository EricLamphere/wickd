// Failed scheduled runs the viewer hasn't looked at yet (plan 27): the red dot on the
// Runs nav item and the Schedule tab. "Seen up to" is the highest schedule event id the
// viewer has seen, per project, in localStorage — a per-viewer convenience, so a
// missing or blocked store just means the dot shows until the next view.
import type { RunScheduleDto, ScheduleOutcome } from './schedulesApi';

export const FAILED_OUTCOMES: ReadonlySet<ScheduleOutcome> = new Set(['error', 'invalid', 'skipped_busy']);
export const SEEN_EVENT = 'wickd:schedule-alerts-seen';

type Alertable = Pick<RunScheduleDto, 'id' | 'last_status' | 'last_event_id'>;

/** Schedules whose latest outcome failed after `seenUpTo`. */
export function unseenFailures<T extends Alertable>(schedules: readonly T[], seenUpTo: number): T[] {
  return schedules.filter((s) =>
    s.last_status !== null && FAILED_OUTCOMES.has(s.last_status) && (s.last_event_id ?? 0) > seenUpTo);
}

/** The id to remember once the viewer has seen every schedule's latest outcome. */
export function latestEventId(schedules: readonly Alertable[]): number {
  return schedules.reduce((max, s) => Math.max(max, s.last_event_id ?? 0), 0);
}

const key = (projectId: number) => `schedule-alerts-seen:${projectId}`;

export function loadSeen(projectId: number): number {
  try {
    const value = Number(localStorage.getItem(key(projectId)));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Remember `eventId` as seen (never moves backwards) and tell other components. */
export function saveSeen(projectId: number, eventId: number): void {
  if (eventId <= loadSeen(projectId)) return;
  try {
    localStorage.setItem(key(projectId), String(eventId));
  } catch {
    // storage unavailable: the dot stays until the next view
  }
  window.dispatchEvent(new CustomEvent(SEEN_EVENT, { detail: { projectId } }));
}
