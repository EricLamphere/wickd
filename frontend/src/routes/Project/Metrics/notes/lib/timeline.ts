// Notes tab → Timeline (plan 33): every note on one date axis, a row per metric ("Every metric"
// first), each occurrence of a recurring note as its own bar. Positions are fractions of the
// range, so the view lays them out with percentages. Pure; tested in timeline.test.ts.
import type { MetricNoteDto } from '../../../../../lib/notesApi';
import { dayMs, isoDay, noteColor, occurrences } from './metricNotes';

const DAY_MS = 86_400_000;
export const EVERY_METRIC = '';

export interface TimelineRange {
  start: string;
  end: string;
}

export interface TimelineBar {
  note: MetricNoteDto;
  start: string;
  end: string;
  /** 0–1 across the range (cut to it) */
  left: number;
  width: number;
  color: string;
  /** stacked line within the row, so overlapping bars don't cover each other */
  lane: number;
}

export interface TimelineRow {
  key: string;
  label: string;
  bars: TimelineBar[];
  lanes: number;
}

export const TIMELINE_SPANS = [3, 6, 12, 24] as const;
export type TimelineSpan = (typeof TIMELINE_SPANS)[number];

/** `months` months ending on the later of today and the last note's end (so future notes show). */
export function timelineRange(notes: readonly MetricNoteDto[], months: number, today: string): TimelineRange {
  const latest = notes.reduce((max, n) => (n.end && !n.recurs && n.end > max ? n.end : max), today);
  const end = new Date(dayMs(latest));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, end.getUTCDate() + 1));
  return { start: isoDay(start.getTime()), end: latest };
}

function fraction(iso: string, range: TimelineRange): number {
  const lo = dayMs(range.start);
  const span = dayMs(range.end) + DAY_MS - lo;
  return Math.min(1, Math.max(0, (dayMs(iso) - lo) / span));
}

/** Greedy lanes: each bar goes on the first lane whose last bar ended before it starts. */
function withLanes(bars: Omit<TimelineBar, 'lane'>[]): { bars: TimelineBar[]; lanes: number } {
  const ends: string[] = [];
  const out = [...bars].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end)).map((b) => {
    let lane = ends.findIndex((end) => end < b.start);
    if (lane < 0) { lane = ends.length; ends.push(b.end); } else ends[lane] = b.end;
    return { ...b, lane };
  });
  return { bars: out, lanes: Math.max(1, ends.length) };
}

export function buildTimeline(
  notes: readonly MetricNoteDto[], range: TimelineRange, label: (metric: string) => string = (m) => m,
): TimelineRow[] {
  const byRow = new Map<string, Omit<TimelineBar, 'lane'>[]>();
  for (const note of notes) {
    if (note.error) continue;
    for (const [s, e] of occurrences(note, range.start, range.end)) {
      const left = fraction(s, range);
      const right = fraction(isoDay(dayMs(e) + DAY_MS), range);
      const bar = { note, start: s, end: e, left, width: Math.max(right - left, 0.004), color: noteColor([note]) };
      for (const key of note.metrics.length ? note.metrics : [EVERY_METRIC]) {
        byRow.set(key, [...(byRow.get(key) ?? []), bar]);
      }
    }
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => (a === EVERY_METRIC ? -1 : b === EVERY_METRIC ? 1 : label(a).localeCompare(label(b))))
    .map(([key, bars]) => ({ key, label: key === EVERY_METRIC ? 'Every metric' : label(key), ...withLanes(bars) }));
}

/** A tick at each month start inside the range ("Jan 2026" on January, else "Feb"). */
export function monthTicks(range: TimelineRange): { left: number; label: string }[] {
  const ticks: { left: number; label: string }[] = [];
  const start = new Date(dayMs(range.start));
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (start.getUTCDate() === 1 ? 0 : 1), 1));
  while (isoDay(d.getTime()) <= range.end) {
    const iso = isoDay(d.getTime());
    const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    ticks.push({ left: fraction(iso, range), label: d.getUTCMonth() === 0 ? `${month} ${d.getUTCFullYear()}` : month });
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return ticks;
}

/** Where today sits (0–1), or null outside the range. */
export function todayMark(range: TimelineRange, today: string): number | null {
  return today < range.start || today > range.end ? null : fraction(today, range);
}
