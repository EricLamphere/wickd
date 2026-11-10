import { describe, expect, it } from 'vitest';
import { describeTiming, formatCheckTime, presetLabel, timingChoice, timingFor } from './scheduleView';

describe('timing choices', () => {
  it('maps a timing to a select value and back', () => {
    expect(timingChoice({ interval_hours: null, cron: null })).toBe('off');
    expect(timingChoice({ interval_hours: 6, cron: null })).toBe('interval:6');
    expect(timingChoice({ interval_hours: null, cron: '0 9 * * *' })).toBe('cron');
    expect(timingFor('off')).toEqual({ interval_hours: null, cron: null });
    expect(timingFor('interval:12')).toEqual({ interval_hours: 12, cron: null });
    expect(timingFor('cron')).toBeNull();
  });

  it('describes a timing', () => {
    expect(describeTiming({ interval_hours: null, cron: null })).toBe('off');
    expect(describeTiming({ interval_hours: 1, cron: null })).toBe('every hour');
    expect(describeTiming({ interval_hours: 6, cron: null })).toBe('every 6 h');
    expect(describeTiming({ interval_hours: null, cron: '0 9 * * 1-5' })).toBe('Weekdays at 9:00');
    expect(describeTiming({ interval_hours: null, cron: '15 4 * * *' })).toBe('cron 15 4 * * *');
    expect(presetLabel('1 2 3 4 5')).toBeNull();
  });
});

describe('formatCheckTime', () => {
  const now = new Date(2026, 10, 1, 10, 0);
  it('is relative to today', () => {
    expect(formatCheckTime(new Date(2026, 10, 1, 10, 0, 30).toISOString(), now)).toBe('now');
    expect(formatCheckTime(new Date(2026, 10, 1, 9, 0).toISOString(), now)).toBe('now');
    expect(formatCheckTime(new Date(2026, 10, 1, 17, 5).toISOString(), now)).toBe('today 17:05');
    expect(formatCheckTime(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toBe('tomorrow 09:00');
    expect(formatCheckTime(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toMatch(/9.*09:00$/);
  });
});
