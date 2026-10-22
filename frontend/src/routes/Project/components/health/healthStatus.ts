import type { CheckSummary, HealthCheckStatus, HealthSummary } from '../../../../lib/api';

export type Tone = 'ok' | 'warn' | 'fail' | 'running' | 'idle';

/** Badge beside a Health tab label: the issue count, or a dot while running. */
export function tabBadge(check: CheckSummary): { label: string | null; tone: Tone } | null {
  if (check.status === 'running') return { label: null, tone: 'running' };
  if (check.status === 'warn' || check.status === 'fail') {
    return { label: check.issues > 0 ? String(check.issues) : '!', tone: check.status };
  }
  return null;
}

/** Worst problem across the three checks, for the dot on the nav rail's Health item. */
export function navAlert(summary: HealthSummary | undefined): 'warn' | 'fail' | null {
  if (!summary) return null;
  const statuses = [summary.connection, summary.drift, summary.freshness].map((c) => c.status);
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return null;
}

export function toneFor(status: HealthCheckStatus): Tone {
  return status === 'not_run' ? 'idle' : status;
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  fail: 'text-red-400',
  running: 'text-brand-400',
  idle: 'text-gray-500',
};

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  fail: 'bg-red-500',
  running: 'bg-brand-500 animate-pulse',
  idle: 'bg-gray-600',
};

export const TONE_BADGE: Record<Tone, string> = {
  ok: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
  warn: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  fail: 'bg-red-950/40 text-red-300 border-red-900/60',
  running: 'bg-brand-950/40 text-brand-300 border-brand-900/60',
  idle: 'bg-surface-elevated text-gray-500 border-gray-700',
};
