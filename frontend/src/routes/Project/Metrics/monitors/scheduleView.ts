// Metric monitor schedules: the project's auto-check (off / every N h / cron) and a
// monitor's override (project / off / cron) as select values and labels. Pure;
// unit-tested in scheduleView.test.ts. The generic parts (presets, next-run times) are in
// components/schedule/scheduleView.ts.
import type { MonitorDto, MonitorListDto, MonitorScheduleSettings } from '../../../../lib/monitorsApi';

export { CRON_PRESETS, CUSTOM, formatCheckTime, INTERVALS, OFF, presetLabel } from '../../../../components/schedule/scheduleView';
import { CUSTOM, OFF, presetLabel } from '../../../../components/schedule/scheduleView';

export const FOLLOW_PROJECT = 'project';

/** The project select's value: 'off', 'interval:<h>' or 'cron'. */
export function projectChoice(data: Pick<MonitorListDto, 'interval_hours' | 'schedule'>): string {
  if (data.schedule) return CUSTOM;
  return data.interval_hours ? `interval:${data.interval_hours}` : OFF;
}

/** What to save for a project select value; null for 'cron' (the expression comes from the field). */
export function projectSettingsFor(choice: string): MonitorScheduleSettings | null {
  if (choice === CUSTOM) return null;
  if (choice.startsWith('interval:')) return { interval_hours: Number(choice.slice('interval:'.length)), schedule: null };
  return { interval_hours: null, schedule: null };
}

export function describeProjectSchedule(data: Pick<MonitorListDto, 'interval_hours' | 'schedule'>): string {
  if (data.schedule) return presetLabel(data.schedule) ?? `cron ${data.schedule}`;
  return data.interval_hours ? `every ${data.interval_hours} h` : 'off';
}

/** A monitor's override select value: 'project', 'off' or 'cron'. */
export function monitorChoice(monitor: Pick<MonitorDto, 'schedule'>): string {
  if (monitor.schedule === null) return FOLLOW_PROJECT;
  return monitor.schedule === OFF ? OFF : CUSTOM;
}
