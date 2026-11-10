// Schedules shared by metric monitors and scheduled runs: interval / cron choices, cron
// presets, labels and next-run times. Pure; unit-tested in scheduleView.test.ts.
// Cron runs on the machine's local time.

export const INTERVALS = [1, 3, 6, 12, 24] as const;
export const CUSTOM = 'cron';
export const OFF = 'off';

export const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Every day at 7:00', expr: '0 7 * * *' },
  { label: 'Weekdays at 9:00', expr: '0 9 * * 1-5' },
  { label: 'Mondays at 8:00', expr: '0 8 * * 1' },
  { label: 'First of the month at 6:00', expr: '0 6 1 * *' },
];

/** A schedule's timing: every N hours, a cron expression, or neither (off). */
export interface ScheduleTiming {
  interval_hours: number | null;
  cron: string | null;
}

/** The select value for a timing: 'off', 'interval:<h>' or 'cron'. */
export function timingChoice(t: ScheduleTiming): string {
  if (t.cron) return CUSTOM;
  return t.interval_hours ? `interval:${t.interval_hours}` : OFF;
}

/** The timing for a select value; null for 'cron' (the expression comes from the field). */
export function timingFor(choice: string): ScheduleTiming | null {
  if (choice === CUSTOM) return null;
  if (choice.startsWith('interval:')) return { interval_hours: Number(choice.slice('interval:'.length)), cron: null };
  return { interval_hours: null, cron: null };
}

export function describeTiming(t: ScheduleTiming): string {
  if (t.cron) return presetLabel(t.cron) ?? `cron ${t.cron}`;
  if (!t.interval_hours) return 'off';
  return t.interval_hours === 1 ? 'every hour' : `every ${t.interval_hours} h`;
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
