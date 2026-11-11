import { describe, expect, it } from 'vitest';
import {
  type ActivityEvent,
  type ActivityState,
  EMPTY_ACTIVITY,
  MAX_FINISHED,
  dismissFinished,
  reduceActivity,
  seedActivity,
} from './activity';
import { MAX_PANEL_ROWS, SUCCESS_LINGER_MS, bubbleView, formatElapsed, isRowExpanded, panelRows, runsPageLink } from './activityView';

const T0 = 1_000_000;

function play(events: ActivityEvent[], start: ActivityState = EMPTY_ACTIVITY): ActivityState {
  return events.reduce((state, event, i) => reduceActivity(state, event, T0 + i * 1000), start);
}

const ev = (type: string, data: unknown = {}): ActivityEvent => ({ type, data });

describe('reduceActivity — dbt commands', () => {
  it('tracks a build from start to success with node progress', () => {
    const state = play([
      ev('run_started', { command: 'build', label: 'build', select: 'orders+', started_at: '2026-11-11T10:00:00Z' }),
      ev('run_log', { line: '10:00:01  1 of 3 START sql view model main.stg_orders ......... [RUN]' }),
      ev('run_log', { line: '10:00:01  1 of 3 OK created sql view model main.stg_orders .... [OK in 0.1s]' }),
      ev('run_log', { line: '10:00:02  2 of 3 PASS not_null_orders_id ...................... [PASS in 0.1s]' }),
      ev('run_finished', { return_code: 0 }),
    ]);
    expect(state.activities).toHaveLength(1);
    const [run] = state.activities;
    expect(run.kind).toBe('run');
    expect(run.title).toBe('dbt build -s orders+');
    expect(run.status).toBe('success');
    expect(run.progress).toEqual({ done: 2, total: 3 });
    expect(run.log).toHaveLength(3);
    expect(run.cancellable).toBe(false); // only while running
    expect(run.open).toEqual({ kind: 'bottom-tab', tab: 'run' });
    expect(run.finishedAt).toBe(T0 + 4000);
    expect(state.runKey).toBeNull();
  });

  it('ends red on a non-zero exit and yellow when a line warned', () => {
    const failed = play([ev('run_started', { command: 'test', label: 'test' }), ev('run_finished', { return_code: 1 })]);
    expect(failed.activities[0].status).toBe('error');
    const warned = play([
      ev('run_started', { command: 'run', label: 'run' }),
      ev('run_log', { line: 'Done. PASS=1 WARN=2 ERROR=0 SKIP=0 TOTAL=3' }),
      ev('run_finished', { return_code: 0 }),
    ]);
    expect(warned.activities[0].status).toBe('warn');
  });

  it('can be cancelled only while running', () => {
    const state = play([ev('run_started', { command: 'run', label: 'run' })]);
    expect(state.activities[0].cancellable).toBe(true);
  });

  it('has no progress for commands without nodes', () => {
    const state = play([ev('run_started', { command: 'debug', label: 'debug' })]);
    expect(state.activities[0].progress).toBeNull();
    expect(state.activities[0].title).toBe('dbt debug');
  });

  it('marks a missing dbt executable as an error', () => {
    const state = play([
      ev('run_started', { command: 'run', label: 'run' }),
      ev('run_error', { message: 'dbt executable not found on PATH' }),
    ]);
    expect(state.activities[0].status).toBe('error');
    expect(state.activities[0].log).toContain('dbt executable not found on PATH');
  });

  it('keeps only the tail of the log, without ANSI codes', () => {
    const lines = Array.from({ length: 80 }, (_, i) => ev('run_log', { line: `\x1B[32mline ${i}\x1B[0m` }));
    const state = play([ev('run_started', { command: 'run', label: 'run' }), ...lines]);
    expect(state.activities[0].log).toHaveLength(50);
    expect(state.activities[0].log[49]).toBe('line 79');
  });
});

describe('reduceActivity — compile, docs, init', () => {
  it('tracks a project compile', () => {
    const state = play([ev('compile_started'), ev('compile_finished', { ok: false })]);
    expect(state.activities[0]).toMatchObject({ kind: 'compile', title: 'Compiling project', status: 'error' });
    expect(state.activities[0].open).toEqual({ kind: 'bottom-tab', tab: 'project-logs' });
  });

  it('folds a single-model compile run into its compile activity', () => {
    const state = play([
      ev('compile_started'),
      ev('run_started', { command: 'compile', label: 'compile', select: 'orders' }),
      ev('run_log', { line: 'Compiled node orders' }),
      ev('run_finished', { return_code: 0 }),
      ev('compile_finished', { ok: true }),
    ]);
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({ kind: 'compile', status: 'success', log: ['Compiled node orders'] });
  });

  it('tracks docs generation', () => {
    const running = play([ev('docs_generating')]);
    expect(running.activities[0]).toMatchObject({ kind: 'docs', title: 'Generating docs', status: 'running' });
    expect(running.activities[0].open).toEqual({ kind: 'page', page: 'docs' });
    const done = reduceActivity(running, ev('docs_generated', { ok: true }), T0 + 5000);
    expect(done.activities[0].status).toBe('success');
  });

  it('tracks the init pipeline step by step', () => {
    let state = play([
      ev('init_pipeline_started', { steps: ['base: pip install', 'base: dbt deps'] }),
      ev('init_step', { name: 'base: pip install', status: 'running' }),
    ]);
    expect(state.activities[0]).toMatchObject({ title: 'Init: pip install', progress: { done: 0, total: 2 } });
    state = play([
      ev('init_step', { name: 'base: pip install', status: 'success', log: 'Successfully installed\nok' }),
      ev('init_step', { name: 'base: dbt deps', status: 'running' }),
    ], state);
    expect(state.activities[0]).toMatchObject({ title: 'Init: dbt deps', progress: { done: 1, total: 2 } });
    expect(state.activities[0].log).toEqual(['Successfully installed', 'ok']);
    state = play([
      ev('init_step', { name: 'base: dbt deps', status: 'error', log: 'boom' }),
      ev('init_pipeline_finished', { status: 'error', failed_step: 'base: dbt deps' }),
    ], state);
    expect(state.activities[0]).toMatchObject({ status: 'error', title: 'Init failed: dbt deps' });
    expect(state.activities[0].open).toEqual({ kind: 'page', page: 'init' });
  });
});

describe('reduceActivity — overlap and odd orderings', () => {
  it('keeps overlapping activities, newest first', () => {
    const state = play([
      ev('init_pipeline_started', { steps: ['base: dbt docs generate'] }),
      ev('docs_generating'),
      ev('docs_generated', { ok: true }),
    ]);
    expect(state.activities.map((a) => [a.kind, a.status])).toEqual([['docs', 'success'], ['init', 'running']]);
  });

  it('records a finish without a start as a finished entry', () => {
    const state = play([ev('docs_generated', { ok: false }), ev('run_finished', { return_code: 0, command: 'seed' })]);
    expect(state.activities.map((a) => [a.kind, a.status, a.startedAt])).toEqual([
      ['run', 'success', null],
      ['docs', 'error', null],
    ]);
  });

  it('reuses a running docs or compile activity instead of starting a second one', () => {
    const seeded = seedActivity(EMPTY_ACTIVITY, { run: null, init: null, compile: null, docs: { started_at: null } });
    const state = play([ev('docs_generating'), ev('docs_generated', { ok: true })], seeded);
    expect(state.activities.map((a) => [a.kind, a.status])).toEqual([['docs', 'success']]);
  });

  it('settles every running activity of the kind on finish', () => {
    const state = play([ev('compile_started'), ev('compile_started'), ev('compile_finished', { ok: true })]);
    expect(state.activities.every((a) => a.status === 'success')).toBe(true);
  });

  it('marks a run the server stopped streaming as failed', () => {
    const state = play([
      ev('run_started', { command: 'run', label: 'run' }),
      ev('run_finished', { return_code: -1, abandoned: true }),
    ]);
    expect(state.activities[0].status).toBe('error');
    expect(state.activities[0].log).toContain('Stopped before dbt finished');
  });

  it('ignores unrelated events', () => {
    expect(reduceActivity(EMPTY_ACTIVITY, ev('graph_changed'), T0)).toBe(EMPTY_ACTIVITY);
    expect(reduceActivity(EMPTY_ACTIVITY, ev('run_log', { line: 'stray' }), T0)).toBe(EMPTY_ACTIVITY);
  });

  it(`keeps the last ${MAX_FINISHED} finished activities, never dropping running ones`, () => {
    const many = Array.from({ length: 15 }, () => [ev('compile_started'), ev('compile_finished', { ok: true })]).flat();
    const state = play([ev('docs_generating'), ...many]);
    expect(state.activities.filter((a) => a.status !== 'running')).toHaveLength(MAX_FINISHED);
    expect(state.activities.some((a) => a.kind === 'docs' && a.status === 'running')).toBe(true);
  });
});

describe('seedActivity', () => {
  const snapshot = {
    run: { command: 'build', label: 'build', select: null, started_at: '2026-11-11T10:00:00Z', invocation_id: 12, command_line: 'dbt build' },
    init: { steps: ['base: pip install', 'base: dbt deps'], current_step: 'base: dbt deps', started: 2, started_at: '2026-11-11T09:59:00Z' },
    compile: null,
    docs: { started_at: null },
  };

  it('seeds what was running before the page opened', () => {
    const state = seedActivity(EMPTY_ACTIVITY, snapshot);
    expect(state.activities.map((a) => [a.kind, a.title, a.seeded])).toEqual([
      ['run', 'dbt build', true],
      ['init', 'Init: dbt deps', true],
      ['docs', 'Generating docs', true],
    ]);
    expect(state.activities[0].invocationId).toBe(12);
    expect(state.activities[0].commandLine).toBe('dbt build');
    expect(state.activities[0].startedAt).toBe(Date.parse('2026-11-11T10:00:00Z'));
    expect(state.activities[1].progress).toEqual({ done: 1, total: 2 });
    expect(state.activities[2].startedAt).toBeNull();
    // run_log lines after seeding land on the seeded run
    const next = reduceActivity(state, ev('run_finished', { return_code: 0 }), T0 + 1);
    expect(next.activities[0].status).toBe('success');
  });

  it('does not duplicate activities events already reported', () => {
    const live = play([ev('run_started', { command: 'build', label: 'build' })]);
    const state = seedActivity(live, { run: snapshot.run, init: null, compile: null, docs: null });
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0].seeded).toBe(false);
  });

  it('does not resurrect a run that finished before the snapshot landed', () => {
    const live = play([ev('run_finished', { return_code: 0, command: 'build' })]);
    const state = seedActivity(live, { run: snapshot.run, init: null, compile: null, docs: null });
    expect(state.activities.map((a) => a.status)).toEqual(['success']);
  });

  it('folds a compile run into the compile activity', () => {
    const state = seedActivity(EMPTY_ACTIVITY, {
      run: { command: 'compile', label: 'compile', select: 'orders', started_at: '2026-11-11T10:00:00Z', invocation_id: null, command_line: 'dbt compile --select orders' },
      init: null,
      compile: { started_at: '2026-11-11T10:00:00Z' },
      docs: null,
    });
    expect(state.activities.map((a) => a.kind)).toEqual(['compile']);
    expect(state.runKey).toBe(state.activities[0].key);
  });
});

describe('bubbleView', () => {
  it('rests as an idle dot with nothing to show', () => {
    expect(bubbleView(EMPTY_ACTIVITY, T0)).toMatchObject({ mode: 'dot', status: 'idle', celebrate: null });
  });

  it('shows the newest running activity in blue, with a count of the rest', () => {
    const state = play([ev('docs_generating'), ev('run_started', { command: 'build', label: 'build' })]);
    expect(bubbleView(state, T0 + 5000)).toMatchObject({ mode: 'pill', status: 'running', title: 'dbt build', more: 1, celebrate: null });
  });

  it('lingers on success, then shrinks to a dot', () => {
    const state = play([ev('compile_started'), ev('compile_finished', { ok: true })]);
    const finishedAt = state.activities[0].finishedAt as number;
    const fresh = bubbleView(state, finishedAt + 100);
    expect(fresh).toMatchObject({ mode: 'pill', status: 'success' });
    expect(fresh.celebrate).toEqual({ key: state.activities[0].key, effect: 'confetti' });
    const later = bubbleView(state, finishedAt + SUCCESS_LINGER_MS + 1);
    expect(later).toMatchObject({ mode: 'dot', status: 'success', celebrate: null });
  });

  it('keeps errors and warnings up until dismissed, and shakes', () => {
    const state = play([ev('docs_generating'), ev('docs_generated', { ok: false })]);
    const view = bubbleView(state, T0 + 60 * 60 * 1000);
    expect(view).toMatchObject({ mode: 'pill', status: 'error', title: 'Generating docs' });
    const fresh = bubbleView(state, (state.activities[0].finishedAt as number) + 100);
    expect(fresh.celebrate).toEqual({ key: state.activities[0].key, effect: 'shake' });
    expect(bubbleView(dismissFinished(state), T0 + 60 * 60 * 1000)).toMatchObject({ mode: 'dot', status: 'error', celebrate: null });
  });

  it('dismissing never hides what is still running', () => {
    const state = dismissFinished(play([ev('docs_generating')]));
    expect(bubbleView(state, T0).mode).toBe('pill');
  });
});

describe('run links', () => {
  it('records the invocation id from run_started and the activity snapshot', () => {
    const live = play([ev('run_started', {
      command: 'build', label: 'build', invocation_id: 41, command_line: 'dbt build --select orders+ --full-refresh',
    })]);
    expect(live.activities[0].invocationId).toBe(41);
    expect(live.activities[0].commandLine).toBe('dbt build --select orders+ --full-refresh');
    const unrecorded = play([ev('run_started', { command: 'build', label: 'build' })]);
    expect(unrecorded.activities[0].invocationId).toBeNull();
    expect(unrecorded.activities[0].commandLine).toBeNull();
    expect(play([ev('docs_generating')]).activities[0].invocationId).toBeNull();
  });

  it('links to the Runs page with that run selected', () => {
    expect(runsPageLink(3, 41)).toBe('/projects/3/runs?run=41');
  });
});

describe('panelRows', () => {
  it('lists running activities first and caps the list', () => {
    const finished = Array.from({ length: 4 }, () => [ev('compile_started'), ev('compile_finished', { ok: true })]).flat();
    const state = play([ev('docs_generating'), ...finished, ev('run_started', { command: 'build', label: 'build' })]);
    const rows = panelRows(state.activities);
    expect(rows).toHaveLength(MAX_PANEL_ROWS);
    expect(rows.slice(0, 2).map((a) => a.status)).toEqual(['running', 'running']);
    expect(rows.slice(2).every((a) => a.status === 'success')).toBe(true);
  });
});

describe('isRowExpanded', () => {
  it('opens only the newest row unless the user toggled one', () => {
    const state = play([
      ev('compile_started'), ev('compile_finished', { ok: true }),
      ev('docs_generating'), ev('docs_generated', { ok: true }),
    ]);
    const [newest, older] = state.activities;
    expect(isRowExpanded(state.activities, newest.key, new Map())).toBe(true);
    expect(isRowExpanded(state.activities, older.key, new Map())).toBe(false);
    const toggled = new Map([[newest.key, false], [older.key, true]]);
    expect(isRowExpanded(state.activities, newest.key, toggled)).toBe(false);
    expect(isRowExpanded(state.activities, older.key, toggled)).toBe(true);
  });
});

describe('formatElapsed', () => {
  it('reads like a stopwatch', () => {
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(4_900)).toBe('4s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
    expect(formatElapsed(3_780_000)).toBe('1h 03m');
  });
});
