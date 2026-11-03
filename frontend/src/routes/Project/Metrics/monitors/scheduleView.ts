// Metric monitor schedules: the project's auto-check (off / every N h / cron) and a
// monitor's override (project / off / cron) as select values, labels and next-check
// times. Pure; unit-tested in scheduleView.test.ts. Cron runs on the machine's local time.
import type { MonitorDto, MonitorListDto, MonitorScheduleSettings } from '../../../../lib/monitorsApi';

export const INTERVALS = [1, 3, 6, 12, 24] as const;
export const CUSTOM = 'cron';
export const OFF = 'off';
export const FOLLOW_PROJECT = 'project';

export const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Every day at 7:00', expr: '0 7 * * *' },
  { label: 'Weekdays at 9:00', expr: '0 9 * * 1-5' },
  { label: 'Mondays at 8:00', expr: '0 8 * * 1' },
  { label: 'First of the month at 6:00', expr: '0 6 1 * *' },
];

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

export function presetLabel(expr: string): string | null {
  return CRON_PRESETS.find((p) => p.expr === expr)?.label ?? null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "today 09:00", "tomorrow 09:00", "Mon 3 Nov 09:00" in local time; "now" when due. */
export function formatCheckTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (at.getTime() - now.getTime() < 60_000) return 'now';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const date = at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${date} ${time}`;
}
