// The query composer's date phrases (plan 16): what you can type for the period (`last 90 days`,
// `2026`, `Q1`, `since March`, `2026-01-01 to 2026-03-31`) and for the comparison (`previous`,
// `last year`, `nothing`). The dashboards' presets stay presets; anything else becomes fixed
// dates, resolved against `today` (local date) when typed. Pure; unit-tested in composer.test.ts.
import type { ComparePeriod, CurrentPeriod, DateRange, PeriodPreset } from '../../../../lib/dashboardsApi';
import { CURRENT_PRESETS, isRange, resolveCurrent } from '../dashboards/periods';

const PRESET_ALIASES: Record<string, PeriodPreset> = {
  mtd: 'month_to_date', qtd: 'quarter_to_date', ytd: 'year_to_date',
  'this month': 'month_to_date', 'this quarter': 'quarter_to_date', 'this year': 'year_to_date',
  all: 'all_time', 'all time': 'all_time', ever: 'all_time',
  'last 7 days': 'last_7_days', 'last 30 days': 'last_30_days', 'last 90 days': 'last_90_days',
  'last 12 months': 'last_12_months', 'last month': 'last_month', 'last quarter': 'last_quarter',
};
for (const p of CURRENT_PRESETS) PRESET_ALIASES[p.label.toLowerCase()] = p.key;

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7 };
const PRESET_DAYS: Record<number, PeriodPreset> = { 7: 'last_7_days', 30: 'last_30_days', 90: 'last_90_days' };

/** Phrases offered while typing a period (the presets' labels first). */
export const PERIOD_SUGGESTIONS = [
  ...CURRENT_PRESETS.map((p) => p.label.toLowerCase()),
  'today', 'yesterday', 'this week', 'last week', 'this year', 'last year', 'since ',
];
/** Phrases offered after `vs`. */
export const COMPARE_SUGGESTIONS = ['previous period', 'last year', 'nothing'];

// ── calendar arithmetic on plain dates (UTC midnight, like dashboards/periods.ts) ──

function day(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** `d` moved by `n` months, clamped to the month's last day (Mar 31 − 1 month = Feb 28). */
function addMonths(d: Date, n: number): Date {
  const first = day(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
  const last = day(first.getUTCFullYear(), first.getUTCMonth() + 1, 0).getUTCDate();
  return day(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), last));
}

function span(start: Date, end: Date): DateRange {
  return { start: iso(start), end: iso(end) };
}

function monthSpan(y: number, m: number): DateRange {
  return span(day(y, m, 1), day(y, m + 1, 0));
}

function quarterSpan(y: number, q: number): DateRange {
  return span(day(y, 3 * (q - 1), 1), day(y, 3 * q, 0));
}

function todayOf(today: Date): Date {
  return day(today.getFullYear(), today.getMonth(), today.getDate());
}

function monday(d: Date): Date {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
}

function validDay(y: number, m: number, d: number): boolean {
  const date = day(y, m, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m && date.getUTCDate() === d;
}

function monthIndex(word: string): number {
  if (word.length < 3) return -1;
  return MONTH_NAMES.findIndex((m) => m.startsWith(word));
}

/** One calendar span: a year, month, quarter, day, month name, today / yesterday. */
function parseSpan(text: string, today: Date): DateRange | null {
  const t = todayOf(today);
  let m: RegExpMatchArray | null;
  if (text === 'today') return span(t, t);
  if (text === 'yesterday') return span(addDays(t, -1), addDays(t, -1));
  if ((m = text.match(/^(\d{4})$/))) {
    const y = Number(m[1]);
    return y >= 1900 && y <= 2200 ? span(day(y, 0, 1), day(y, 11, 31)) : null;
  }
  if ((m = text.match(/^(\d{4})-(\d{1,2})$/))) {
    const mo = Number(m[2]) - 1;
    return mo >= 0 && mo < 12 ? monthSpan(Number(m[1]), mo) : null;
  }
  if ((m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    return validDay(y, mo, d) ? span(day(y, mo, d), day(y, mo, d)) : null;
  }
  if ((m = text.match(/^q([1-4])(?: (\d{4}))?$/))) return quarterSpan(m[2] ? Number(m[2]) : t.getUTCFullYear(), Number(m[1]));
  if ((m = text.match(/^(\d{4}) q([1-4])$/))) return quarterSpan(Number(m[1]), Number(m[2]));
  if ((m = text.match(/^([a-z]+)(?: (\d{1,2}))?(?:,? (\d{4}))?$/))) {
    const mo = monthIndex(m[1]);
    if (mo < 0) return null;
    // no year: the latest one that isn't in the future
    const y = m[3] ? Number(m[3]) : (mo > t.getUTCMonth() ? t.getUTCFullYear() - 1 : t.getUTCFullYear());
    if (!m[2]) return monthSpan(y, mo);
    const d = Number(m[2]);
    return validDay(y, mo, d) ? span(day(y, mo, d), day(y, mo, d)) : null;
  }
  return null;
}

function relative(text: string, today: Date): DateRange | PeriodPreset | null {
  const t = todayOf(today);
  const m = text.match(/^(?:last|past) (\d{1,4}) (day|week|month|year)s?$/);
  if (m) {
    const n = Number(m[1]);
    if (n < 1) return null;
    const unit = m[2];
    if (unit === 'day' && PRESET_DAYS[n]) return PRESET_DAYS[n];
    if (unit === 'month' && n === 12) return 'last_12_months';
    // like the presets, "last N …" ends yesterday (today is still filling in)
    const end = addDays(t, -1);
    if (unit in UNIT_DAYS) return span(addDays(end, -(n * UNIT_DAYS[unit] - 1)), end);
    return span(addDays(addMonths(end, -(unit === 'year' ? 12 * n : n)), 1), end);
  }
  if (text === 'this week') return span(monday(t), t);
  if (text === 'last week') {
    const start = addDays(monday(t), -7);
    return span(start, addDays(start, 6));
  }
  if (text === 'last year') return span(day(t.getUTCFullYear() - 1, 0, 1), day(t.getUTCFullYear() - 1, 11, 31));
  return null;
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A typed period phrase as the widget's current period (null = not a date phrase). */
export function parseDatePhrase(input: string, today: Date = new Date()): CurrentPeriod | null {
  const text = normalise(input);
  if (!text) return null;
  const pastText = text.replace(/^past /, 'last ');
  if (PRESET_ALIASES[pastText]) return PRESET_ALIASES[pastText];
  const rel = relative(pastText, today);
  if (rel) return rel;
  const since = text.match(/^since (.+)$/);
  if (since) {
    const from = parseSpan(since[1], today);
    return from ? { start: from.start, end: iso(todayOf(today)) } : null;
  }
  const between = text.match(/^(?:from |between )?(.+?) (?:to|until|through|-|and) (.+)$/);
  if (between) {
    const a = parseSpan(between[1], today);
    const b = parseSpan(between[2], today);
    return a && b && a.start <= b.end ? { start: a.start, end: b.end } : null;
  }
  return parseSpan(text, today);
}

/** A typed comparison phrase (after `vs`): previous / last year / nothing, or other dates. */
export function parseComparePhrase(input: string, today: Date = new Date()): ComparePeriod | null {
  const text = normalise(input).replace(/^the /, '');
  if (['previous', 'previous period', 'prior period', 'last period', 'prior'].includes(text)) return 'previous_period';
  if (['last year', 'previous year', 'prior year', 'same period last year', 'a year ago', 'year ago'].includes(text)) return 'previous_year';
  if (['nothing', 'none', 'no comparison'].includes(text)) return 'none';
  const period = parseDatePhrase(text, today);
  if (!period) return null;
  return isRange(period) ? period : resolveCurrent(period, today);
}

/** Text that parses back to `period` (a chip turned back into text to edit it). */
export function periodText(period: CurrentPeriod): string {
  if (isRange(period)) return period.start === period.end ? period.start : `${period.start} to ${period.end}`;
  return CURRENT_PRESETS.find((p) => p.key === period)?.label.toLowerCase() ?? period;
}

export function compareText(compare: ComparePeriod): string {
  if (isRange(compare)) return `vs ${periodText(compare)}`;
  return compare === 'previous_year' ? 'vs last year' : compare === 'none' ? 'vs nothing' : 'vs previous';
}
