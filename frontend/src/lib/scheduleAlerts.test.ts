import { describe, expect, it } from 'vitest';
import { latestEventId, unseenFailures } from './scheduleAlerts';

const rows = [
  { id: 1, last_status: 'error' as const, last_event_id: 10 },
  { id: 2, last_status: 'success' as const, last_event_id: 12 },
  { id: 3, last_status: 'skipped_busy' as const, last_event_id: 5 },
  { id: 4, last_status: 'missed' as const, last_event_id: 20 },
  { id: 5, last_status: null, last_event_id: null },
  { id: 6, last_status: 'invalid' as const, last_event_id: 15 },
];

describe('unseenFailures', () => {
  it('counts failed, invalid and skipped outcomes after the seen mark', () => {
    expect(unseenFailures(rows, 0).map((r) => r.id)).toEqual([1, 3, 6]);
    expect(unseenFailures(rows, 10).map((r) => r.id)).toEqual([6]);
    expect(unseenFailures(rows, 15)).toEqual([]);
  });

  it('ignores missed runs (wickd was closed) and never-run schedules', () => {
    expect(unseenFailures(rows, 0).some((r) => r.id === 4 || r.id === 5)).toBe(false);
  });
});

describe('latestEventId', () => {
  it('is the highest event id', () => {
    expect(latestEventId(rows)).toBe(20);
    expect(latestEventId([])).toBe(0);
  });
});
