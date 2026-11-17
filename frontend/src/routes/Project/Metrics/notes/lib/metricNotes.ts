// Metric notes (plan 30): which notes apply where, where they sit on a chart, and what the
// New note dialog starts with from each entry point. Pure; tested in metricNotes.test.ts.
// noteMatches() mirrors backend app/semantic/notes.py matches() (shared fixture table:
// backend/tests/fixtures/notes/match_cases.json).
import type { MetricNoteDto } from '../../../../../lib/notesApi';
import type { PointKind } from '../../../../../lib/monitorsApi';

/** The note fields matching reads (a listed note, or a fixture row). */
export interface NoteScope {
  start: string | null;
  end: string | null;
  metrics: string[];
  dimension: string | null;
  value: string | null;
}

export interface NoteContext {
  /** inclusive ISO dates */
  start: string;
  end: string;
  /** null/undefined = any metric */
  metric?: string | null;
  /** dimensions pinned to a value here (a filter, a slice, a clicked bar) */
  dims?: Record<string, string>;
  /** the metric's dimensions, when known (a dimension-only note skips metrics without it) */
  metricDimensions?: string[] | null;
}

/** `order__region` and `region` name the same dimension. */
export function sameDimension(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x === y || x.endsWith(`__${y}`) || y.endsWith(`__${x}`);
}

export function noteMatches(note: NoteScope, ctx: NoteContext): boolean {
  if (!note.start || !note.end) return false; // a file that doesn't parse applies nowhere
  if (note.start > ctx.end || note.end < ctx.start) return false;
  if (ctx.metric && note.metrics.length && !note.metrics.includes(ctx.metric)) return false;
  if (!note.dimension) return true;
  const dim = note.dimension;
  if (!note.metrics.length && ctx.metricDimensions && !ctx.metricDimensions.some((d) => sameDimension(dim, d))) return false;
  for (const [d, v] of Object.entries(ctx.dims ?? {})) {
    if (sameDimension(dim, d) && String(v).trim().toLowerCase() !== String(note.value ?? '').trim().toLowerCase()) return false;
  }
  return true;
}

/** Notes that apply to any of `metrics` (or any metric, for none) over the context. */
export function notesFor<T extends NoteScope>(notes: readonly T[], ctx: Omit<NoteContext, 'metric'> & { metrics?: readonly string[] }): T[] {
  const metrics = ctx.metrics?.length ? ctx.metrics : [null];
  return notes.filter((n) => metrics.some((metric) => noteMatches(n, { ...ctx, metric })));
}

// ── dates ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** The start (UTC ms) of the `grain` period holding `iso` (weeks start on Monday, like MetricFlow). */
export function periodStartMs(iso: string, grain: string): number {
  const ms = dayMs(iso);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (grain) {
    case 'week': return ms - ((d.getUTCDay() + 6) % 7) * DAY_MS;
    case 'month': return Date.UTC(y, m, 1);
    case 'quarter': return Date.UTC(y, Math.floor(m / 3) * 3, 1);
    case 'year': return Date.UTC(y, 0, 1);
    default: return ms;
  }
}

/** The last day (ISO) of the `grain` period starting at `iso`. */
export function periodEnd(iso: string, grain: string): string {
  const start = periodStartMs(iso, grain);
  const d = new Date(start);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (grain) {
    case 'week': return isoDay(start + 6 * DAY_MS);
    case 'month': return isoDay(Date.UTC(y, m + 1, 0));
    case 'quarter': return isoDay(Date.UTC(y, m + 3, 0));
    case 'year': return isoDay(Date.UTC(y, 12, 0));
    default: return isoDay(start);
  }
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// ── chart bands ──────────────────────────────────────────────────────────────

export interface NoteBand<T extends NoteScope = MetricNoteDto> {
  /** x values (UTC ms of period starts, as series() parses them); x1 === x2 is a single period (a line) */
  x1: number;
  x2: number;
  notes: T[];
}

/**
 * Where notes sit on a time series whose points are `xs` (period starts, UTC ms) at `grain`:
 * a note covers the periods holding its first and last day (a one-day note at week grain covers
 * that week), cut to the chart. Notes covering the same periods share a band.
 */
export function notesOnSeries<T extends NoteScope>(notes: readonly T[], xs: readonly number[], grain: string): NoteBand<T>[] {
  if (!xs.length) return [];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const bands = new Map<string, NoteBand<T>>();
  for (const n of notes) {
    if (!n.start || !n.end) continue;
    const a = periodStartMs(n.start, grain);
    const b = periodStartMs(n.end, grain);
    if (b < lo || a > hi) continue;
    const x1 = Math.max(a, lo);
    const x2 = Math.min(b, hi);
    const key = `${x1}:${x2}`;
    const band = bands.get(key);
    if (band) band.notes.push(n); else bands.set(key, { x1, x2, notes: [n] });
  }
  return [...bands.values()].sort((p, q) => p.x1 - q.x1 || p.x2 - q.x2);
}

/** Dimension values a set of MetricFlow filters pins (`{{ Dimension('x') }} = 'EU'`), for matching. */
export function pinnedDims(filters: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\{\{\s*Dimension\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}\s*=\s*'((?:[^']|'')*)'/i;
  for (const f of filters) {
    const m = re.exec(f);
    if (m && !/\b(or|and)\b/i.test(f.replace(m[0], ''))) out[m[1]] = m[2].replace(/''/g, "'");
  }
  return out;
}

// ── New note dialog defaults ─────────────────────────────────────────────────

export interface NotePrefill {
  title: string;
  start: string;
  end: string;
  metrics: string[];
  dimension: string | null;
  value: string | null;
  body: string;
}

/** Where Add note… was chosen, with what it knows. */
export type NoteEntry =
  | { kind: 'metric'; metric: string | null; range?: { start: string; end: string } | null }
  | { kind: 'widget'; metrics: string[]; range: { start: string; end: string } | null; dims?: Record<string, string> }
  | { kind: 'value'; metrics: string[]; range: { start: string; end: string } | null; dimension?: string | null; value?: string | null }
  | { kind: 'period'; metric: string; period: string; grain: string; dimension?: string | null; value?: string | null };

const EMPTY_BODY = '';

/** The dialog's starting values for an entry point; with no dates known, today. */
export function prefillFrom(entry: NoteEntry, today: string = todayIso()): NotePrefill {
  const base = { title: '', body: EMPTY_BODY, dimension: null as string | null, value: null as string | null };
  switch (entry.kind) {
    case 'metric':
      return { ...base, metrics: entry.metric ? [entry.metric] : [], start: entry.range?.start ?? today, end: entry.range?.end ?? today };
    case 'widget': {
      const [dimension, value] = Object.entries(entry.dims ?? {})[0] ?? [null, null];
      return { ...base, metrics: entry.metrics.slice(0, 1), start: entry.range?.start ?? today, end: entry.range?.end ?? today, dimension, value };
    }
    case 'value':
      return {
        ...base, metrics: entry.metrics.slice(0, 1), start: entry.range?.start ?? today, end: entry.range?.end ?? today,
        dimension: entry.dimension && entry.value != null ? entry.dimension : null,
        value: entry.dimension && entry.value != null ? entry.value : null,
      };
    case 'period':
      return {
        ...base, metrics: [entry.metric], start: entry.period, end: periodEnd(entry.period, entry.grain),
        dimension: entry.dimension && entry.value ? entry.dimension : null, value: entry.dimension && entry.value ? entry.value : null,
      };
  }
}

// ── Mark as expected → note ──────────────────────────────────────────────────

export interface ExpectedFlag {
  metric: string;
  /** the metric's label, for the title */
  label?: string | null;
  period: string;
  grain: string;
  kind: PointKind | '';
  value: number | null;
  expected: number | null;
  dimension?: string | null;
  /** the slice's value ('' unsliced) */
  slice?: string;
  format?: (v: number) => string;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "Revenue spike on 2026-10-12", "No revenue data on 2026-11-06", … */
export function expectedTitle(flag: ExpectedFlag): string {
  const name = flag.label || flag.metric;
  const slice = flag.slice ? ` (${flag.slice})` : '';
  const on = `on ${flag.period}`;
  switch (flag.kind) {
    case 'missing': return `No ${name} data${slice} ${on}`;
    case 'zero': return `${capitalize(name)} at zero${slice} ${on}`;
    case 'level_shift': return `${capitalize(name)} level shift${slice} from ${flag.period}`;
    case 'restated': return `${capitalize(name)} restated${slice} for ${flag.period}`;
    default: {
      if (flag.value != null && flag.expected != null && flag.value !== flag.expected) {
        return `${capitalize(name)} ${flag.value > flag.expected ? 'spike' : 'drop'}${slice} ${on}`;
      }
      return `Unusual ${name}${slice} ${on}`;
    }
  }
}

export function expectedPrefill(flag: ExpectedFlag): NotePrefill {
  const fmt = flag.format ?? ((v: number) => v.toLocaleString());
  const facts = flag.value == null
    ? 'No data arrived for this period.'
    : `${fmt(flag.value)}${flag.expected != null ? ` vs ${fmt(flag.expected)} expected` : ''}.`;
  return {
    title: expectedTitle(flag),
    start: flag.period,
    end: periodEnd(flag.period, flag.grain),
    metrics: [flag.metric],
    dimension: flag.dimension && flag.slice ? flag.dimension : null,
    value: flag.dimension && flag.slice ? flag.slice : null,
    body: `${facts} Marked as expected because…\n`,
  };
}

// ── listing ──────────────────────────────────────────────────────────────────

/** "2026-11" → "November 2026" (the Notes tab's month groups, by a note's start). */
export function monthLabel(iso: string): string {
  const d = new Date(dayMs(`${iso.slice(0, 7)}-01`));
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function rangeText(start: string | null, end: string | null): string {
  if (!start) return '';
  return !end || end === start ? start : `${start} – ${end}`;
}

export interface NotesFilter {
  text: string;
  metric: string | null;
  dimension: string | null;
  start: string | null;
  end: string | null;
}

export function filterNotes<T extends MetricNoteDto>(notes: readonly T[], f: NotesFilter): T[] {
  const q = f.text.trim().toLowerCase();
  return notes.filter((n) => {
    if (q && !`${n.title}\n${n.body}\n${n.metrics.join(' ')}\n${n.value ?? ''}`.toLowerCase().includes(q)) return false;
    if (f.metric && n.metrics.length && !n.metrics.includes(f.metric)) return false;
    if (f.dimension && !(n.dimension && sameDimension(n.dimension, f.dimension))) return false;
    if ((f.start || f.end) && !n.start) return false;
    if (f.start && (n.end ?? '') < f.start) return false;
    if (f.end && (n.start ?? '') > f.end) return false;
    return true;
  });
}

export type NoteSortBy = 'added' | 'start' | 'end';
export type NoteSortDir = 'desc' | 'asc';
export const NOTE_SORT_BY: readonly NoteSortBy[] = ['added', 'start', 'end'];
export const NOTE_SORT_DIR: readonly NoteSortDir[] = ['desc', 'asc'];

/** The date a note sorts and groups by: added = `created`, else the file's last change. */
export function noteSortDate(n: MetricNoteDto, by: NoteSortBy): string | null {
  if (by === 'added') return n.created ?? n.modified_at;
  return by === 'start' ? n.start : n.end;
}

/**
 * Sorted by the chosen date (newest first by default), grouped by that date's month; notes
 * without one (unreadable files, or no added date) last.
 */
export function groupByMonth<T extends MetricNoteDto>(
  notes: readonly T[], by: NoteSortBy = 'start', dir: NoteSortDir = 'desc',
): { key: string; label: string; notes: T[] }[] {
  const sign = dir === 'desc' ? -1 : 1;
  const sorted = [...notes].sort((a, b) => {
    const da = noteSortDate(a, by);
    const db = noteSortDate(b, by);
    if (!da || !db) return (da ? -1 : 0) + (db ? 1 : 0) || a.title.localeCompare(b.title);
    return sign * da.localeCompare(db) || a.title.localeCompare(b.title);
  });
  const groups: { key: string; label: string; notes: T[] }[] = [];
  for (const n of sorted) {
    const date = noteSortDate(n, by);
    const key = date ? date.slice(0, 7) : n.error ? 'invalid' : 'undated';
    const last = groups[groups.length - 1];
    if (last?.key === key) last.notes.push(n);
    else groups.push({ key, label: date ? monthLabel(date.slice(0, 10)) : n.error ? "Couldn't be read" : 'No date', notes: [n] });
  }
  return groups;
}
