import { describe, expect, it } from 'vitest';
import cases from '../../../../../../../backend/tests/fixtures/notes/match_cases.json';
import type { MetricNoteDto } from '../../../../../lib/notesApi';
import {
  dayMs, expectedPrefill, type NoteSortBy, type NoteSortDir, expectedTitle, filterNotes, groupByMonth, noteMatches, notesFor, notesOnSeries, periodEnd,
  pinnedDims, prefillFrom, type NoteScope, occurrences, noteColor, allTags, parseTags, INCIDENT_COLOR, NOTE_COLOR,
} from './metricNotes';

type Ctx = { start: string; end: string; metric?: string; dims?: Record<string, string>; metric_dimensions?: string[] };

describe('noteMatches (shared with the backend)', () => {
  const notes = cases.notes as Record<string, NoteScope>;
  for (const c of cases.cases as { name: string; note: string; ctx: Ctx; expect: boolean }[]) {
    it(c.name, () => {
      const { metric_dimensions: metricDimensions, ...ctx } = c.ctx;
      expect(noteMatches(notes[c.note], { ...ctx, metricDimensions })).toBe(c.expect);
    });
  }
  it('never matches an unreadable file', () => {
    expect(noteMatches({ start: null, end: null, metrics: [], dimension: null, value: null }, { start: '2000-01-01', end: '2100-01-01' })).toBe(false);
  });
});

const note = (over: Partial<MetricNoteDto>): MetricNoteDto => ({
  slug: 'n', path: 'wickd/notes/n.md', title: 'N', start: '2026-11-03', end: '2026-11-03', metrics: [], dimension: null,
  value: null, created: null, body: '', error: null, warnings: [], modified_at: null,
  tags: [], type: 'note', status: null, resolved: null, recurs: null, widget: null, source: null, models: [], commits: [], links: [], ...over,
});

describe('notesFor', () => {
  it('matches any of several metrics', () => {
    const list = [note({ slug: 'a', metrics: ['orders'] }), note({ slug: 'b', metrics: ['cost'] })];
    expect(notesFor(list, { start: '2026-11-01', end: '2026-11-30', metrics: ['revenue', 'orders'] }).map((n) => n.slug)).toEqual(['a']);
    expect(notesFor(list, { start: '2026-11-01', end: '2026-11-30' })).toHaveLength(2);
  });
});

describe('notesOnSeries', () => {
  const week = (iso: string) => dayMs(iso);
  it('puts a one-day note on its week at week grain', () => {
    const xs = [week('2026-10-26'), week('2026-11-02'), week('2026-11-09')];
    const bands = notesOnSeries([note({ start: '2026-11-04', end: '2026-11-04' })], xs, 'week');
    expect(bands).toEqual([{ x1: week('2026-11-02'), x2: week('2026-11-02'), notes: [expect.anything()] }]);
  });
  it('spans days, clips to the chart and groups notes on the same periods', () => {
    const xs = [dayMs('2026-11-01'), dayMs('2026-11-02'), dayMs('2026-11-03')];
    const bands = notesOnSeries([
      note({ slug: 'a', start: '2026-10-20', end: '2026-11-02' }),
      note({ slug: 'b', start: '2026-11-01', end: '2026-11-02' }),
      note({ slug: 'c', start: '2026-12-01', end: '2026-12-02' }),
    ], xs, 'day');
    expect(bands).toHaveLength(1);
    expect(bands[0].x1).toBe(dayMs('2026-11-01'));
    expect(bands[0].x2).toBe(dayMs('2026-11-02'));
    expect(bands[0].notes.map((n) => n.slug)).toEqual(['a', 'b']);
  });
  it('handles month grain and no points', () => {
    expect(notesOnSeries([note({})], [dayMs('2026-11-01')], 'month')[0].x1).toBe(dayMs('2026-11-01'));
    expect(notesOnSeries([note({})], [], 'day')).toEqual([]);
  });
});

describe('periodEnd', () => {
  it('ends each grain', () => {
    expect(periodEnd('2026-11-04', 'day')).toBe('2026-11-04');
    expect(periodEnd('2026-11-02', 'week')).toBe('2026-11-08');
    expect(periodEnd('2026-02-01', 'month')).toBe('2026-02-28');
    expect(periodEnd('2026-04-01', 'quarter')).toBe('2026-06-30');
  });
});

describe('pinnedDims', () => {
  it('reads equality filters only', () => {
    expect(pinnedDims([
      "{{ Dimension('order__region') }} = 'EU'",
      "{{ Dimension('order__channel') }} = 'it''s'",
      "{{ Dimension('x') }} = 'a' or {{ Dimension('x') }} = 'b'",
      "{{ Dimension('y') }} > 3",
    ])).toEqual({ order__region: 'EU', order__channel: "it's" });
  });
});

describe('prefillFrom', () => {
  const today = '2026-11-16';
  it('a metric with no dates: today', () => {
    expect(prefillFrom({ kind: 'metric', metric: 'revenue' }, today)).toMatchObject({ metrics: ['revenue'], start: today, end: today });
    expect(prefillFrom({ kind: 'metric', metric: null }, today).metrics).toEqual([]);
  });
  it('a widget: its first metric, period and pinned dimension', () => {
    expect(prefillFrom({ kind: 'widget', metrics: ['a', 'b'], range: { start: '2026-10-01', end: '2026-10-31' }, dims: { region: 'EU' } }, today))
      .toMatchObject({ metrics: ['a'], start: '2026-10-01', end: '2026-10-31', dimension: 'region', value: 'EU' });
  });
  it('a value: its dimension value', () => {
    expect(prefillFrom({ kind: 'value', metrics: ['a'], range: null, dimension: 'region', value: 'EU' }, today))
      .toMatchObject({ start: today, dimension: 'region', value: 'EU' });
    expect(prefillFrom({ kind: 'value', metrics: ['a'], range: null, dimension: 'region' }, today).dimension).toBeNull();
  });
  it('a monitor period: the whole period and the slice', () => {
    expect(prefillFrom({ kind: 'period', metric: 'revenue', period: '2026-11-02', grain: 'week', dimension: 'region', value: 'EU' }, today))
      .toMatchObject({ start: '2026-11-02', end: '2026-11-08', dimension: 'region', value: 'EU' });
    expect(prefillFrom({ kind: 'period', metric: 'revenue', period: '2026-11-02', grain: 'day', dimension: 'region', value: '' }, today).dimension).toBeNull();
  });
});

describe('expected prefill', () => {
  const flag = { metric: 'revenue', period: '2026-10-12', grain: 'day', value: 150, expected: 100, kind: 'anomaly' as const };
  it('titles each kind of flag', () => {
    expect(expectedTitle(flag)).toBe('Revenue spike on 2026-10-12');
    expect(expectedTitle({ ...flag, value: 50 })).toBe('Revenue drop on 2026-10-12');
    expect(expectedTitle({ ...flag, kind: 'missing', value: null })).toBe('No revenue data on 2026-10-12');
    expect(expectedTitle({ ...flag, kind: 'zero', value: 0 })).toBe('Revenue at zero on 2026-10-12');
    expect(expectedTitle({ ...flag, kind: 'level_shift' })).toBe('Revenue level shift from 2026-10-12');
    expect(expectedTitle({ ...flag, label: 'Net revenue', slice: 'EU' })).toBe('Net revenue spike (EU) on 2026-10-12');
    expect(expectedTitle({ ...flag, value: null, expected: null, kind: '' })).toBe('Unusual revenue on 2026-10-12');
  });
  it('fills the range, slice and a body stub (gap periods too)', () => {
    const p = expectedPrefill({ ...flag, grain: 'week', period: '2026-11-02', dimension: 'region', slice: 'EU' });
    expect(p).toMatchObject({ start: '2026-11-02', end: '2026-11-08', dimension: 'region', value: 'EU', metrics: ['revenue'] });
    expect(p.body).toContain('150 vs 100 expected');
    expect(expectedPrefill({ ...flag, kind: 'missing', value: null }).body).toContain('No data arrived');
  });
});

describe('listing', () => {
  const list = [
    note({ slug: 'a', title: 'Outage', start: '2026-11-03', end: '2026-11-04', metrics: ['revenue'], dimension: 'order__region', value: 'EU' }),
    note({ slug: 'b', title: 'Launch', start: '2026-10-20', end: '2026-10-20', body: 'new pricing' }),
    note({ slug: 'c', title: 'c', start: null, end: null, error: 'bad' }),
  ];
  it('filters by text, metric, dimension and dates', () => {
    const f = { text: '', metric: null, dimension: null, start: null, end: null };
    expect(filterNotes(list, { ...f, text: 'pricing' }).map((n) => n.slug)).toEqual(['b']);
    expect(filterNotes(list, { ...f, metric: 'orders' }).map((n) => n.slug)).toEqual(['b', 'c']);
    expect(filterNotes(list, { ...f, dimension: 'region' }).map((n) => n.slug)).toEqual(['a']);
    expect(filterNotes(list, { ...f, start: '2026-11-04' }).map((n) => n.slug)).toEqual(['a']);
  });
  it('groups by month, newest first, unreadable last', () => {
    expect(groupByMonth(list).map((g) => [g.label, g.notes.map((n) => n.slug)])).toEqual([
      ['November 2026', ['a']], ['October 2026', ['b']], ["Couldn't be read", ['c']],
    ]);
  });
  it('sorts and groups by start, end or date added, either direction', () => {
    const notes = [
      note({ slug: 'x', title: 'x', start: '2026-09-01', end: '2026-11-30', created: '2026-09-02T10:00:00Z' }),
      note({ slug: 'y', title: 'y', start: '2026-10-01', end: '2026-10-02', created: null, modified_at: '2026-08-15T09:00:00Z' }),
      note({ slug: 'z', title: 'z', start: '2026-10-05', end: '2026-10-05', created: null, modified_at: null }),
    ];
    const slugs = (by: NoteSortBy, dir?: NoteSortDir) => groupByMonth(notes, by, dir).flatMap((g) => g.notes.map((n) => n.slug));
    expect(slugs('start')).toEqual(['z', 'y', 'x']);
    expect(slugs('start', 'asc')).toEqual(['x', 'y', 'z']);
    expect(slugs('end')).toEqual(['x', 'z', 'y']);
    expect(groupByMonth(notes, 'end')[0].label).toBe('November 2026');
    // added falls back to the file's last change; no date at all goes last either way
    expect(slugs('added')).toEqual(['x', 'y', 'z']);
    expect(slugs('added', 'asc')).toEqual(['y', 'x', 'z']);
    expect(groupByMonth(notes, 'added').map((g) => g.label)).toEqual(['September 2026', 'August 2026', 'No date']);
  });
});

describe('recurring notes and incidents (plan 33)', () => {
  const xmas = note({ start: '2025-12-24', end: '2025-12-26', recurs: 'yearly' });
  it('lists every year\'s occurrence in a range', () => {
    expect(occurrences(xmas, '2024-01-01', '2026-12-25')).toEqual([
      ['2024-12-24', '2024-12-26'], ['2025-12-24', '2025-12-26'], ['2026-12-24', '2026-12-26']]);
    expect(occurrences(note({}), '2026-11-04', '2026-11-05')).toEqual([]);
  });
  it('puts a band on every year a chart shows', () => {
    const xs = ['2024-12-01', '2025-06-01', '2025-12-01', '2026-01-01'].map(dayMs);
    expect(notesOnSeries([xmas], xs, 'month').map((b) => [b.x1, b.x2])).toEqual([[dayMs('2025-12-01'), dayMs('2025-12-01')], [dayMs('2024-12-01'), dayMs('2024-12-01')]].sort((a, b) => a[0] - b[0]));
  });
  it('colors open incidents red', () => {
    expect(noteColor([note({ status: 'resolved' }), note({})])).toBe(NOTE_COLOR);
    expect(noteColor([note({}), note({ status: 'open' })])).toBe(INCIDENT_COLOR);
  });
  it('filters by tag, status and recurring dates', () => {
    const list = [note({ slug: 'a', tags: ['Outage'], type: 'incident', status: 'open' }), note({ slug: 'b', type: 'incident', status: 'resolved' }), note({ slug: 'r', type: 'release' }), xmas];
    const f = { text: '', metric: null, dimension: null, start: null, end: null };
    expect(filterNotes(list, { ...f, tag: 'outage' }).map((n) => n.slug)).toEqual(['a']);
    expect(filterNotes(list, { ...f, type: 'open' }).map((n) => n.slug)).toEqual(['a']);
    expect(filterNotes(list, { ...f, type: 'incident' }).map((n) => n.slug)).toEqual(['a', 'b']);
    expect(filterNotes(list, { ...f, type: 'release' }).map((n) => n.slug)).toEqual(['r']);
    expect(filterNotes(list, { ...f, type: 'note' })).toEqual([xmas]);
    expect(filterNotes(list, { ...f, start: '2027-12-25', end: '2027-12-25' })).toEqual([xmas]);
  });
  it('collects and parses tags', () => {
    expect(allTags([note({ tags: ['b', 'a'] }), note({ tags: ['A'] })])).toEqual(['a', 'b']);
    expect(parseTags('outage, #Checkout ,OUTAGE,, ')).toEqual(['outage', 'Checkout']);
  });
  it('keeps the widget a note starts from', () => {
    const p = prefillFrom({ kind: 'widget', metrics: ['revenue'], range: null, widget: { type: 'summary' }, source: { dashboard: 'k', widget: 'w1' } }, '2026-11-03');
    expect(p.widget).toEqual({ type: 'summary' });
    expect(p.source).toEqual({ dashboard: 'k', widget: 'w1' });
    expect(prefillFrom({ kind: 'metric', metric: null }, '2026-11-03').widget).toBeNull();
  });
});
