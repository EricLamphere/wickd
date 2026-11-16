// Highlighting part of a time series: the periods between two points as an inclusive date range
// (what a dashboard period takes), and which points fall in such a range (to zoom the chart on
// it). Points are the start of their period in UTC ms, as series() parses them. Pure; tested in
// timeRange.test.ts.
import type { DateRange } from '../../../../lib/dashboardsApi';

const DAY_MS = 86_400_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The last day (UTC ms at midnight) of the period starting at `x`. */
export function periodLastDay(x: number, grain: string): number {
  const d = new Date(x);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (grain) {
    case 'week': return x + 6 * DAY_MS;
    case 'month': return Date.UTC(y, m + 1, 0);
    case 'quarter': return Date.UTC(y, Math.floor(m / 3) * 3 + 3, 0);
    case 'year': return Date.UTC(y, 12, 0);
    default: return Date.UTC(y, m, d.getUTCDate());
  }
}

/** The periods from `a` to `b` (either order) as an inclusive date range. */
export function rangeBetween(a: number, b: number, grain: string): DateRange {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { start: iso(lo), end: iso(periodLastDay(hi, grain)) };
}

/** Whether the period starting at `x` begins inside `range`. */
export function inRange(x: number, range: DateRange): boolean {
  const day = iso(x);
  return day >= range.start && day <= range.end;
}

/** Indexes of `xs` inside `range` (all of them without a range, or when fewer than one is inside). */
export function zoomedIndexes(xs: readonly number[], range: DateRange | null): number[] {
  const all = xs.map((_, i) => i);
  if (!range) return all;
  const kept = all.filter((i) => inRange(xs[i], range));
  return kept.length ? kept : all;
}
