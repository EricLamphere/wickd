// Dashboard periods (plan 12): preset lists and labels, and resolving a period to dates the
// same way the backend does (semantic/dashboard_periods.py). Unit-tested in dashboardModel.test.ts.
import type { ComparePeriod, CurrentPeriod, DateRange, PeriodPreset } from '../../../../lib/dashboardsApi';

// ── periods ──────────────────────────────────────────────────────────────────

export const CURRENT_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'last_7_days', label: 'Last 7 days' },
  { key: 'last_30_days', label: 'Last 30 days' },
  { key: 'last_90_days', label: 'Last 90 days' },
  { key: 'last_12_months', label: 'Last 12 months' },
  { key: 'month_to_date', label: 'Month to date' },
  { key: 'quarter_to_date', label: 'Quarter to date' },
  { key: 'year_to_date', label: 'Year to date' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_quarter', label: 'Last quarter' },
  { key: 'all_time', label: 'All time' },
];

export const COMPARE_PRESETS = [
  { key: 'previous_period', label: 'Previous period' },
  { key: 'previous_year', label: 'Same period last year' },
  { key: 'none', label: 'No comparison' },
] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m, d];
}

/** "Mar 1 – 31, 2026", "Feb 3 – Mar 2, 2026", "Dec 1, 2025 – Jan 4, 2026". */
export function rangeLabel(range: DateRange | null | undefined): string {
  if (!range) return 'All time';
  const [y1, m1, d1] = parts(range.start);
  const [y2, m2, d2] = parts(range.end);
  if (range.start === range.end) return `${MONTHS[m1 - 1]} ${d1}, ${y1}`;
  if (y1 !== y2) return `${MONTHS[m1 - 1]} ${d1}, ${y1} – ${MONTHS[m2 - 1]} ${d2}, ${y2}`;
  if (m1 !== m2) return `${MONTHS[m1 - 1]} ${d1} – ${MONTHS[m2 - 1]} ${d2}, ${y2}`;
  return `${MONTHS[m1 - 1]} ${d1} – ${d2}, ${y2}`;
}

export function isRange(value: unknown): value is DateRange {
  return typeof value === 'object' && value !== null && 'start' in value && 'end' in value;
}

export function currentLabel(current: CurrentPeriod | undefined): string {
  if (!current) return 'Last 30 days';
  if (isRange(current)) return rangeLabel(current);
  return CURRENT_PRESETS.find((p) => p.key === current)?.label ?? current;
}

export function compareLabel(compare: ComparePeriod | undefined): string {
  if (!compare) return 'Previous period';
  if (isRange(compare)) return rangeLabel(compare);
  return COMPARE_PRESETS.find((p) => p.key === compare)?.label ?? compare;
}

// ── period resolution (mirrors backend semantic/dashboard_periods.py) ────────

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function yearAgo(d: Date): Date {
  const y = d.getUTCFullYear() - 1;
  const leap = d.getUTCMonth() === 1 && d.getUTCDate() === 29;
  return utc(y, d.getUTCMonth(), leap ? 28 : d.getUTCDate());
}

const quarterStart = (d: Date) => utc(d.getUTCFullYear(), 3 * Math.floor(d.getUTCMonth() / 3), 1);

/** Explicit dates for the current period (null = all time), relative to `today` (local date). */
export function resolveCurrent(current: CurrentPeriod, today: Date = new Date()): DateRange | null {
  if (isRange(current)) return current;
  const t = utc(today.getFullYear(), today.getMonth(), today.getDate());
  const range = (start: Date, end: Date = t) => ({ start: iso(start), end: iso(end) });
  const days: Record<string, number> = { last_7_days: 7, last_30_days: 30, last_90_days: 90 };
  if (current in days) return range(addDays(t, -(days[current] - 1)));
  switch (current) {
    case 'last_12_months': return range(addDays(yearAgo(t), 1));
    case 'month_to_date': return range(utc(t.getUTCFullYear(), t.getUTCMonth(), 1));
    case 'quarter_to_date': return range(quarterStart(t));
    case 'year_to_date': return range(utc(t.getUTCFullYear(), 0, 1));
    case 'last_month': {
      const end = addDays(utc(t.getUTCFullYear(), t.getUTCMonth(), 1), -1);
      return range(utc(end.getUTCFullYear(), end.getUTCMonth(), 1), end);
    }
    case 'last_quarter': {
      const end = addDays(quarterStart(t), -1);
      return range(quarterStart(end), end);
    }
    default: return null;
  }
}

export function resolveCompare(compare: ComparePeriod, current: DateRange | null): DateRange | null {
  if (!current || compare === 'none') return null;
  if (isRange(compare)) return compare;
  const start = new Date(`${current.start}T00:00:00Z`);
  const end = new Date(`${current.end}T00:00:00Z`);
  if (compare === 'previous_year') return { start: iso(yearAgo(start)), end: iso(yearAgo(end)) };
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevEnd = addDays(start, -1);
  return { start: iso(addDays(prevEnd, -(days - 1))), end: iso(prevEnd) };
}
