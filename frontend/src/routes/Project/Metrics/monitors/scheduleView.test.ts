import { describe, expect, it } from 'vitest';
import {
  describeProjectSchedule, monitorChoice, presetLabel, projectChoice, projectSettingsFor,
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
