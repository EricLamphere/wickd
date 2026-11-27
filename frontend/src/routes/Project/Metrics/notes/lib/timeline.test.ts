import { describe, expect, it } from 'vitest';
import type { MetricNoteDto } from '../../../../../lib/notesApi';
import { INCIDENT_COLOR, NOTE_COLOR } from './metricNotes';
import { buildTimeline, monthTicks, timelineRange, todayMark } from './timeline';

const note = (over: Partial<MetricNoteDto>): MetricNoteDto => ({
  slug: 'n', path: 'p', title: 'N', start: '2026-11-03', end: '2026-11-03', metrics: [], dimension: null, value: null,
  created: null, body: '', error: null, warnings: [], modified_at: null, tags: [], type: 'note', status: null, resolved: null, recurs: null,
  widget: null, source: null, models: [], commits: [], links: [], ...over,
});
const RANGE = { start: '2026-01-01', end: '2026-12-31' };

describe('buildTimeline', () => {
  it('rows per metric, every metric first, a note in each of its metrics', () => {
    const rows = buildTimeline([note({ slug: 'a', metrics: ['revenue', 'orders'] }), note({ slug: 'b' })], RANGE, (m) => m.toUpperCase());
    expect(rows.map((r) => [r.key, r.label, r.bars.length])).toEqual([['', 'Every metric', 1], ['orders', 'ORDERS', 1], ['revenue', 'REVENUE', 1]]);
  });
  it('places bars as fractions and colors incidents', () => {
    const [row] = buildTimeline([note({ start: '2026-01-01', end: '2026-01-31', type: 'incident', status: 'open' })], RANGE);
    expect(row.bars[0].left).toBe(0);
    expect(row.bars[0].width).toBeCloseTo(31 / 365, 5);
    expect(row.bars[0].color).toBe(INCIDENT_COLOR);
  });
  it('stacks overlapping bars on lanes and repeats recurring notes', () => {
    const rows = buildTimeline([
      note({ slug: 'a', start: '2026-03-01', end: '2026-03-10' }),
      note({ slug: 'b', start: '2026-03-05', end: '2026-03-06' }),
      note({ slug: 'c', start: '2026-03-11', end: '2026-03-12' }),
    ], RANGE);
    expect(rows[0].bars.map((b) => [b.note.slug, b.lane])).toEqual([['a', 0], ['b', 1], ['c', 0]]);
    expect(rows[0].lanes).toBe(2);
    const yearly = buildTimeline([note({ start: '2024-12-24', end: '2024-12-26', recurs: 'yearly' })], { start: '2025-01-01', end: '2026-12-31' });
    expect(yearly[0].bars.map((b) => b.start)).toEqual(['2025-12-24', '2026-12-24']);
    expect(yearly[0].bars[0].color).toBe(NOTE_COLOR);
  });
  it('skips unreadable notes', () => expect(buildTimeline([note({ error: 'x', start: null })], RANGE)).toEqual([]));
});

describe('range and ticks', () => {
  it('ends on today or a later note', () => {
    expect(timelineRange([], 3, '2026-11-27')).toEqual({ start: '2026-08-28', end: '2026-11-27' });
    expect(timelineRange([note({ end: '2026-12-10' })], 3, '2026-11-27').end).toBe('2026-12-10');
  });
  it('ticks month starts', () => {
    expect(monthTicks({ start: '2025-11-15', end: '2026-02-10' }).map((t) => t.label)).toEqual(['Dec', 'Jan 2026', 'Feb']);
    expect(todayMark(RANGE, '2027-01-01')).toBeNull();
  });
});
