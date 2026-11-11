// What the running-status bubble shows for an activity state at a moment (plan 29). Pure; tested
// in activity.test.ts.

import type { Activity, ActivityState, ActivityStatus } from './activity';

/** How long a success stays as a full pill before shrinking to a dot. */
export const SUCCESS_LINGER_MS = 8000;
/** A finish older than this doesn't celebrate (e.g. the bubble remounted after navigating). */
const CELEBRATE_WINDOW_MS = 3000;

/** The bubble is never hidden: with nothing to report it rests as a dot. */
export type BubbleMode = 'pill' | 'dot';
/** `idle`: nothing has run since the page opened */
export type BubbleStatus = ActivityStatus | 'idle';

export interface Celebration {
  /** the finished activity's key: the bubble celebrates each key once */
  key: string;
  effect: 'confetti' | 'shake';
}

export interface BubbleView {
  mode: BubbleMode;
  status: BubbleStatus;
  title: string;
  /** other running activities beyond the one titled */
  more: number;
  celebrate: Celebration | null;
}

const IDLE: BubbleView = { mode: 'dot', status: 'idle', title: 'No recent activity', more: 0, celebrate: null };

function celebration(a: Activity, now: number): Celebration | null {
  if (a.finishedAt === null || now - a.finishedAt > CELEBRATE_WINDOW_MS) return null;
  return { key: a.key, effect: a.status === 'success' ? 'confetti' : 'shake' };
}

export function bubbleView(state: ActivityState, now: number): BubbleView {
  const running = state.activities.filter((a) => a.status === 'running');
  if (running.length > 0) {
    return { mode: 'pill', status: 'running', title: running[0].title, more: running.length - 1, celebrate: null };
  }
  const latest = state.activities[0];
  if (!latest) return IDLE;
  // a dismissed finish rests as a dot in its outcome's color
  if (latest.acknowledged) return { mode: 'dot', status: latest.status, title: latest.title, more: 0, celebrate: null };
  const base = { status: latest.status, title: latest.title, more: 0, celebrate: celebration(latest, now) };
  if (latest.status !== 'success') return { ...base, mode: 'pill' };
  const lingering = latest.finishedAt !== null && now - latest.finishedAt <= SUCCESS_LINGER_MS;
  return lingering ? { ...base, mode: 'pill' } : { ...base, mode: 'dot', celebrate: null };
}

/** The Runs page with one run selected (RunHistory reads `?run=`). */
export function runsPageLink(projectId: number, invocationId: number): string {
  return `/projects/${projectId}/runs?run=${invocationId}`;
}

/** The expanded panel lists at most this many activities. */
export const MAX_PANEL_ROWS = 5;

/** The panel's rows: running first, then finished (each newest first), at most MAX_PANEL_ROWS. */
export function panelRows(activities: readonly Activity[]): readonly Activity[] {
  return [
    ...activities.filter((a) => a.status === 'running'),
    ...activities.filter((a) => a.status !== 'running'),
  ].slice(0, MAX_PANEL_ROWS);
}

/**
 * Which rows of the expanded panel start open: only the newest (the list's first row); the user's
 * own toggles (`overrides`, by activity key) win.
 */
export function isRowExpanded(
  activities: readonly Activity[], key: string, overrides: ReadonlyMap<string, boolean>,
): boolean {
  return overrides.get(key) ?? activities[0]?.key === key;
}

/** "4s", "2m 05s", "1h 03m": how long an activity has run (or ran). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/**
 * When an activity started, for its panel row: "2:14 PM" today, "Nov 10, 2:14 PM" on another day
 * (with the year when it isn't this year's).
 */
export function formatStartTime(ms: number, now: number, locale?: string): string {
  const at = new Date(ms);
  const today = new Date(now);
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === today.toDateString()) return time;
  const date = at.toLocaleDateString(locale, {
    month: 'short', day: 'numeric', ...(at.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${date}, ${time}`;
}
