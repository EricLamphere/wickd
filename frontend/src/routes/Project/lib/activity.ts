// What's running in a project, for the running-status bubble (plan 29): a reducer from project
// SSE events to a list of activities (dbt commands, the init pipeline, project compiles, docs
// generation), plus seeding from GET /activity after a reload. Pure; tested in activity.test.ts.

import type { ActivitySnapshotDto } from '../../../lib/activityApi';
import { drawsNodes, finishedStatus, isWarningLine, type OperationStatus } from './operationRun';

export type ActivityKind = 'run' | 'init' | 'compile' | 'docs';
export type ActivityStatus = OperationStatus;

/** Where Open jumps to: a bottom pane tab, or a project page. */
export type ActivityOpen =
  | { kind: 'bottom-tab'; tab: 'run' | 'project-logs' }
  | { kind: 'page'; page: 'init' | 'docs' };

export interface Activity {
  key: string;
  kind: ActivityKind;
  title: string;
  status: ActivityStatus;
  /** ms epoch; null when unknown (finished without a start, or docs seeded after a reload) */
  startedAt: number | null;
  finishedAt: number | null;
  progress: { done: number; total: number } | null;
  log: readonly string[];
  warned: boolean;
  /** started before this page opened (from GET /activity): no log before that */
  seeded: boolean;
  /** dismissed from the bubble (finished activities only) */
  acknowledged: boolean;
  open: ActivityOpen;
  cancellable: boolean;
  /** dbt commands recorded on the Runs page: that row's id (null otherwise, or not yet known) */
  invocationId: number | null;
  /** dbt commands: the command as typed, for the copy button (null when the event didn't say) */
  commandLine: string | null;
}

export interface ActivityState {
  /** newest first */
  activities: readonly Activity[];
  /** the activity `run_log` / `run_finished` belong to */
  runKey: string | null;
  seq: number;
}

export interface ActivityEvent {
  type: string;
  data: unknown;
}

export const EMPTY_ACTIVITY: ActivityState = { activities: [], runKey: null, seq: 0 };
export const MAX_FINISHED = 5;
const MAX_LOG_LINES = 50;

const OPEN_BY_KIND: Record<ActivityKind, ActivityOpen> = {
  run: { kind: 'bottom-tab', tab: 'run' },
  compile: { kind: 'bottom-tab', tab: 'project-logs' },
  docs: { kind: 'page', page: 'docs' },
  init: { kind: 'page', page: 'init' },
};

const COMPILE_TITLE = 'Compiling project';
const DOCS_TITLE = 'Generating docs';

// ---- small readers for loosely typed event payloads ----

function field(data: unknown, key: string): unknown {
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
}

function str(data: unknown, key: string): string | null {
  const v = field(data, key);
  return typeof v === 'string' ? v : null;
}

function num(data: unknown, key: string): number | null {
  const v = field(data, key);
  return typeof v === 'number' ? v : null;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function stepLabel(name: string): string {
  return name.replace(/^base:\s*/, '');
}

function runTitle(label: string, select: string | null): string {
  return `dbt ${label}${select ? ` -s ${select}` : ''}`;
}

// ---- state helpers ----

function newActivity(
  state: ActivityState, kind: ActivityKind, title: string, now: number | null, extra: Partial<Activity> = {},
): { state: ActivityState; activity: Activity } {
  const activity: Activity = {
    key: `${kind}:${state.seq + 1}`,
    kind,
    title,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    progress: null,
    log: [],
    warned: false,
    seeded: false,
    acknowledged: false,
    open: OPEN_BY_KIND[kind],
    cancellable: kind === 'run',
    invocationId: null,
    commandLine: null,
    ...extra,
  };
  return { state: { ...state, seq: state.seq + 1, activities: trim([activity, ...state.activities]) }, activity };
}

/** Keeps every running activity and the newest MAX_FINISHED finished ones. */
function trim(activities: readonly Activity[]): readonly Activity[] {
  let finished = 0;
  return activities.filter((a) => a.status === 'running' || ++finished <= MAX_FINISHED);
}

function update(state: ActivityState, key: string | null, fn: (a: Activity) => Activity): ActivityState {
  if (key === null || !state.activities.some((a) => a.key === key)) return state;
  return { ...state, activities: trim(state.activities.map((a) => (a.key === key ? fn(a) : a))) };
}

function runningOf(state: ActivityState, kind: ActivityKind): Activity | undefined {
  return state.activities.find((a) => a.kind === kind && a.status === 'running');
}

function appendLog(a: Activity, lines: readonly string[]): Activity {
  if (lines.length === 0) return a;
  return { ...a, log: [...a.log, ...lines.map(stripAnsi)].slice(-MAX_LOG_LINES) };
}

function finish(a: Activity, status: ActivityStatus, now: number): Activity {
  return { ...a, status, finishedAt: now, cancellable: false };
}

/**
 * Finishes every running activity of `kind` (these finish events aren't paired with a start, so a
 * duplicate start must not leave one running forever), or records a finished one when the start
 * was missed.
 */
function finishKind(
  state: ActivityState, kind: ActivityKind, title: string, status: ActivityStatus, now: number,
  patch: Partial<Activity> = {},
): ActivityState {
  const settle = (a: Activity): Activity => ({ ...finish(a, status, now), ...patch });
  if (runningOf(state, kind)) {
    return {
      ...state,
      activities: trim(state.activities.map((a) => (a.kind === kind && a.status === 'running' ? settle(a) : a))),
    };
  }
  const created = newActivity(state, kind, title, null);
  return update(created.state, created.activity.key, settle);
}

/** Starts an activity of `kind`, or adopts the running one (e.g. seeded before its start event). */
function startKind(state: ActivityState, kind: ActivityKind, title: string, now: number): ActivityState {
  const running = runningOf(state, kind);
  if (!running) return newActivity(state, kind, title, now).state;
  return update(state, running.key, (a) => ({ ...a, startedAt: a.startedAt ?? now }));
}

// ---- dbt commands ----

const RESULT_LINE = /\b(\d+) of (\d+) (OK|ERROR|WARN|PASS|FAIL|SKIP|NO-OP)\b/;
const ANY_COUNT_LINE = /\b\d+ of (\d+) (START|OK|ERROR|WARN|PASS|FAIL|SKIP|NO-OP)\b/;

function nodeProgress(progress: Activity['progress'], line: string): Activity['progress'] {
  if (progress === null) return null;
  const counted = line.match(ANY_COUNT_LINE);
  if (!counted) return progress;
  const total = Number(counted[1]);
  const done = RESULT_LINE.test(line) ? Math.min(progress.done + 1, total) : progress.done;
  return { done, total };
}

function onRunStarted(state: ActivityState, data: unknown, now: number): ActivityState {
  const command = str(data, 'command') ?? 'run';
  const compile = runningOf(state, 'compile');
  if (command === 'compile' && compile) return { ...state, runKey: compile.key }; // a single-model compile
  const title = runTitle(str(data, 'label') ?? command, str(data, 'select'));
  const progress = drawsNodes(command) ? { done: 0, total: 0 } : null;
  const created = newActivity(state, 'run', title, now, {
    progress, invocationId: num(data, 'invocation_id'), commandLine: str(data, 'command_line') || null,
  });
  return { ...created.state, runKey: created.activity.key };
}

function onRunLog(state: ActivityState, data: unknown): ActivityState {
  const raw = str(data, 'line');
  if (raw === null) return state;
  const line = stripAnsi(raw);
  return update(state, state.runKey, (a) => ({
    ...appendLog(a, [line]),
    warned: a.warned || isWarningLine(line),
    progress: nodeProgress(a.progress, line),
  }));
}

function onRunFinished(state: ActivityState, data: unknown, now: number): ActivityState {
  const current = state.activities.find((a) => a.key === state.runKey);
  if (current?.kind === 'compile') return { ...state, runKey: null }; // compile_finished settles it
  if (!current) {
    const command = str(data, 'command') ?? 'run';
    const created = newActivity(state, 'run', runTitle(command, str(data, 'select')), null);
    return onRunFinished({ ...created.state, runKey: created.activity.key }, data, now);
  }
  const status = finishedStatus(num(data, 'return_code'), current.warned);
  const note = field(data, 'abandoned') === true ? ['Stopped before dbt finished'] : [];
  return { ...update(state, current.key, (a) => finish(appendLog(a, note), status, now)), runKey: null };
}

function onRunError(state: ActivityState, data: unknown, now: number): ActivityState {
  const message = str(data, 'message') ?? 'dbt failed to start';
  let next = state;
  let key = state.runKey;
  if (key === null) {
    const created = newActivity(state, 'run', 'dbt', null);
    next = created.state;
    key = created.activity.key;
  }
  return { ...update(next, key, (a) => finish(appendLog(a, [message]), 'error', now)), runKey: null };
}

// ---- init pipeline ----

function onInitStarted(state: ActivityState, data: unknown, now: number): ActivityState {
  const steps = field(data, 'steps');
  const total = Array.isArray(steps) ? steps.length : 0;
  return newActivity(state, 'init', 'Init', now, { progress: { done: 0, total } }).state;
}

function onInitStep(state: ActivityState, data: unknown): ActivityState {
  const running = runningOf(state, 'init');
  const name = str(data, 'name');
  if (!running || name === null) return state;
  const status = str(data, 'status');
  if (status === 'running') return update(state, running.key, (a) => ({ ...a, title: `Init: ${stepLabel(name)}` }));
  const log = (str(data, 'log') ?? '').split('\n').filter((l) => l.trim() !== '');
  return update(state, running.key, (a) => ({
    ...appendLog(a, log),
    progress: a.progress ? { ...a.progress, done: Math.min(a.progress.done + 1, a.progress.total) } : null,
  }));
}

function onInitFinished(state: ActivityState, data: unknown, now: number): ActivityState {
  const failed = str(data, 'status') === 'error';
  const failedStep = str(data, 'failed_step');
  const title = failed ? `Init failed${failedStep ? `: ${stepLabel(failedStep)}` : ''}` : 'Init finished';
  return finishKind(state, 'init', title, failed ? 'error' : 'success', now, { title });
}

// ---- reducer ----

export function reduceActivity(state: ActivityState, event: ActivityEvent, now: number): ActivityState {
  const { type, data } = event;
  switch (type) {
    case 'run_started': return onRunStarted(state, data, now);
    case 'run_log': return onRunLog(state, data);
    case 'run_finished': return onRunFinished(state, data, now);
    case 'run_error': return onRunError(state, data, now);
    case 'compile_started': return startKind(state, 'compile', COMPILE_TITLE, now);
    case 'compile_finished':
      return finishKind(state, 'compile', COMPILE_TITLE, field(data, 'ok') === false ? 'error' : 'success', now);
    case 'docs_generating': return startKind(state, 'docs', DOCS_TITLE, now);
    case 'docs_generated':
      return finishKind(state, 'docs', DOCS_TITLE, field(data, 'ok') === false ? 'error' : 'success', now);
    case 'init_pipeline_started': return onInitStarted(state, data, now);
    case 'init_step': return onInitStep(state, data);
    case 'init_pipeline_finished': return onInitFinished(state, data, now);
    default: return state;
  }
}

/** Marks every finished activity as dismissed, so the bubble only shows what's running. */
export function dismissFinished(state: ActivityState): ActivityState {
  if (!state.activities.some((a) => a.status !== 'running' && !a.acknowledged)) return state;
  return {
    ...state,
    activities: state.activities.map((a) => (a.status === 'running' ? a : { ...a, acknowledged: true })),
  };
}

// ---- seeding (GET /activity) ----

/**
 * Adds what the server says is running and the events haven't reported yet (events win: a kind
 * they already reported is skipped). Logs before the page opened aren't replayed.
 */
export function seedActivity(state: ActivityState, snapshot: ActivitySnapshotDto): ActivityState {
  let next = state;
  // Any activity of the kind means events already covered it, even one that finished before the
  // snapshot landed: seeding it again would leave it running forever.
  const known = (kind: ActivityKind) => state.activities.some((a) => a.kind === kind);
  const seed = (kind: ActivityKind, title: string, startedAt: string | null, extra: Partial<Activity> = {}) => {
    if (known(kind)) return null;
    const created = newActivity(next, kind, title, parseTime(startedAt), { seeded: true, ...extra });
    next = created.state;
    return created.activity.key;
  };
  if (snapshot.docs) seed('docs', DOCS_TITLE, snapshot.docs.started_at);
  if (snapshot.init) {
    const { steps, current_step: step, started, started_at: startedAt } = snapshot.init;
    const done = Math.max(0, started - (step ? 1 : 0));
    seed('init', step ? `Init: ${stepLabel(step)}` : 'Init', startedAt, { progress: { done, total: steps.length } });
  }
  if (snapshot.compile) seed('compile', COMPILE_TITLE, snapshot.compile.started_at);
  const run = snapshot.run;
  if (run && next.runKey === null && !known('run')) {
    const compile = runningOf(next, 'compile');
    if (run.command === 'compile' && compile) {
      next = { ...next, runKey: compile.key };
    } else {
      const progress = drawsNodes(run.command) ? { done: 0, total: 0 } : null;
      const key = seed('run', runTitle(run.label, run.select), run.started_at, {
        progress, invocationId: run.invocation_id ?? null, commandLine: run.command_line || null,
      });
      if (key) next = { ...next, runKey: key };
    }
  }
  return next;
}
