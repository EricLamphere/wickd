// Scheduled runs (plan 27): the editor's draft ↔ API body, outcome pills, and a
// schedule prefilled from a past run or a typed command. Pure; unit-tested in
// scheduleDraft.test.ts.
import type { RunInvocationDto } from '../../../../lib/api';
import type { RunScheduleBody, RunScheduleDto, ScheduleOutcome } from '../../../../lib/schedulesApi';
import { normalizeCommand } from '../../lib/customCommand';

export const DEFAULT_BUSY_WAIT_MINUTES = 30;
export const MAX_BUSY_WAIT_MINUTES = 720;

export interface ScheduleDraft {
  name: string;
  command: string;
  interval_hours: number | null;
  cron: string | null;
  /** '' = the active target when it fires */
  target: string;
  catch_up: boolean;
  busy_wait_minutes: number;
}

export function emptyDraft(command = ''): ScheduleDraft {
  const cmd = normalizeCommand(command);
  return {
    name: suggestName(cmd), command: cmd, interval_hours: null, cron: '0 7 * * *', target: '',
    catch_up: false, busy_wait_minutes: DEFAULT_BUSY_WAIT_MINUTES,
  };
}

export function draftFromSchedule(s: RunScheduleDto): ScheduleDraft {
  return {
    name: s.name, command: s.command, interval_hours: s.interval_hours, cron: s.cron, target: s.target ?? '',
    catch_up: s.catch_up, busy_wait_minutes: s.busy_wait_minutes,
  };
}

/** "build tag:nightly" from "build -s tag:nightly --full-refresh". */
export function suggestName(command: string): string {
  const tokens = normalizeCommand(command).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const words = tokens[0] === 'source' && tokens[1] ? tokens.slice(0, 2) : tokens.slice(0, 1);
  const sel = tokens.findIndex((t) => t === '-s' || t === '--select' || t === '-m' || t === '--models');
  const selector = sel >= 0 ? tokens[sel + 1] : tokens.find((t) => t.startsWith('--select='))?.slice('--select='.length);
  return selector && !selector.startsWith('-') ? `${words.join(' ')} ${selector}` : words.join(' ');
}

/** The first problem with a draft (for the Save button), null when it can be saved. */
export function draftProblem(d: ScheduleDraft): string | null {
  if (!d.name.trim()) return 'Give the schedule a name.';
  if (!normalizeCommand(d.command)) return 'Enter a dbt command.';
  if (!Number.isInteger(d.busy_wait_minutes) || d.busy_wait_minutes < 0 || d.busy_wait_minutes > MAX_BUSY_WAIT_MINUTES) {
    return `Wait if busy must be 0–${MAX_BUSY_WAIT_MINUTES} minutes.`;
  }
  return null;
}

export function bodyFromDraft(d: ScheduleDraft): RunScheduleBody {
  return {
    name: d.name.trim(), command: normalizeCommand(d.command), interval_hours: d.cron ? null : d.interval_hours,
    cron: d.cron || null, target: d.target.trim() || null, catch_up: d.catch_up, busy_wait_minutes: d.busy_wait_minutes,
  };
}

const TARGET_FLAG = /(^|\s)(--target(=|\s+)|-t\s+)(\S+)/;

/** The command's own --target / -t, which wins over the schedule's Target picker. */
export function commandTarget(command: string): string | null {
  return TARGET_FLAG.exec(command)?.[4] ?? null;
}

/** A schedule prefilled from a past run: its command without the injected `dbt` and
 * `--target`, with that target in the Target picker instead. */
export function draftFromInvocation(inv: Pick<RunInvocationDto, 'cli_command' | 'command' | 'selector' | 'target'>): ScheduleDraft {
  const raw = inv.cli_command ?? `${inv.command}${inv.selector ? ` --select ${inv.selector}` : ''}`;
  const target = commandTarget(raw);
  const command = normalizeCommand(raw.replace(TARGET_FLAG, '$1').replace(/\s+/g, ' '));
  return { ...emptyDraft(command), target: target ?? inv.target ?? '' };
}

export type Tone = 'ok' | 'fail' | 'warn' | 'busy' | 'muted';

const OUTCOMES: Record<ScheduleOutcome, { label: string; tone: Tone }> = {
  pending: { label: 'waiting', tone: 'busy' },
  running: { label: 'running', tone: 'busy' },
  success: { label: 'success', tone: 'ok' },
  error: { label: 'failed', tone: 'fail' },
  cancelled: { label: 'cancelled', tone: 'warn' },
  missed: { label: 'missed', tone: 'muted' },
  skipped_busy: { label: 'skipped (busy)', tone: 'warn' },
  invalid: { label: 'invalid command', tone: 'fail' },
};

export function outcomeView(outcome: ScheduleOutcome | null): { label: string; tone: Tone } {
  return outcome ? OUTCOMES[outcome] ?? { label: outcome, tone: 'muted' } : { label: 'never run', tone: 'muted' };
}

export const TONE_CLS: Record<Tone, string> = {
  ok: 'status-badge-success',
  fail: 'status-badge-error',
  warn: 'bg-amber-900/40 text-amber-400',
  busy: 'status-badge-running',
  muted: 'bg-surface-elevated text-gray-400',
};
