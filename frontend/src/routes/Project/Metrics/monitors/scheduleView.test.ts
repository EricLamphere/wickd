import { describe, expect, it } from 'vitest';
import {
  describeProjectSchedule, formatCheckTime, monitorChoice, presetLabel, projectChoice, projectSettingsFor,
} from './scheduleView';

describe('project schedule', () => {
  it('maps settings to a select value and back', () => {
    expect(projectChoice({ interval_hours: null, schedule: null })).toBe('off');
    expect(projectChoice({ interval_hours: 6, schedule: null })).toBe('interval:6');
    expect(projectChoice({ interval_hours: null, schedule: '0 9 * * *' })).toBe('cron');
    expect(projectSettingsFor('off')).toEqual({ interval_hours: null, schedule: null });
    expect(projectSettingsFor('interval:12')).toEqual({ interval_hours: 12, schedule: null });
    expect(projectSettingsFor('cron')).toBeNull();
  });

  it('describes it', () => {
    expect(describeProjectSchedule({ interval_hours: null, schedule: null })).toBe('off');
    expect(describeProjectSchedule({ interval_hours: 3, schedule: null })).toBe('every 3 h');
    expect(describeProjectSchedule({ interval_hours: null, schedule: '0 9 * * 1-5' })).toBe('Weekdays at 9:00');
    expect(describeProjectSchedule({ interval_hours: null, schedule: '15 4 * * *' })).toBe('cron 15 4 * * *');
  });
});

describe('monitor override', () => {
  it('maps the stored value to a select value', () => {
    expect(monitorChoice({ schedule: null })).toBe('project');
    expect(monitorChoice({ schedule: 'off' })).toBe('off');
    expect(monitorChoice({ schedule: '0 7 * * *' })).toBe('cron');
    expect(presetLabel('0 7 * * *')).toBe('Every day at 7:00');
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
