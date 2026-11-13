import { describe, expect, it } from 'vitest';
import type { MetricQueryRunDto } from '../../../../lib/semanticApi';
import { applyProgress, isRunEvent, progressRefresh, progressText, PROGRESS_REFRESH_MS, summarize } from './queryActivity';

const run = (over: Partial<MetricQueryRunDto>): MetricQueryRunDto => ({
  run_id: 'a', kind: 'metrics', label: '', done: 0, total: 10, started_at: '2026-11-13T00:00:00Z',
  finished: false, cancelled: false, ...over,
});

describe('applyProgress', () => {
  it('adds, replaces and removes runs', () => {
    let runs = applyProgress([], run({}));
    runs = applyProgress(runs, run({ run_id: 'b', kind: 'dashboard' }));
    runs = applyProgress(runs, run({ done: 4 }));
    expect(runs.map((r) => [r.run_id, r.done])).toEqual([['b', 0], ['a', 4]]);
    expect(applyProgress(runs, run({ finished: true })).map((r) => r.run_id)).toEqual(['b']);
  });
});

describe('isRunEvent', () => {
  it('accepts run payloads only', () => {
    expect(isRunEvent(run({}))).toBe(true);
    expect(isRunEvent({ run_id: 'a' })).toBe(false);
    expect(isRunEvent(null)).toBe(false);
  });
});

describe('summarize', () => {
  const runs = [run({ done: 3 }), run({ run_id: 'b', kind: 'dashboard', done: 1, total: 4, cancelled: true })];

  it('adds up every run, or the kinds asked for', () => {
    expect(summarize(runs)).toEqual({ runIds: ['a', 'b'], done: 4, total: 14, cancelling: false });
    expect(summarize(runs, ['dashboard'])).toEqual({ runIds: ['b'], done: 1, total: 4, cancelling: true });
    expect(summarize(runs, ['monitors'])).toBeNull();
    expect(summarize([])).toBeNull();
  });

  it('describes the progress', () => {
    expect(progressText({ runIds: ['a'], done: 1234, total: 2000, cancelling: false })).toBe(
      `${(1234).toLocaleString()} / ${(2000).toLocaleString()} queries`);
    expect(progressText({ runIds: ['a'], done: 0, total: 1, cancelling: false })).toBe('1 query');
  });
});

describe('progressRefresh', () => {
  it('refreshes for metric runs making progress, at most every few seconds', () => {
    const now = 100_000;
    expect(progressRefresh(run({ done: 3 }), 0, now)).toBe(true);
    expect(progressRefresh(run({ done: 3 }), now - PROGRESS_REFRESH_MS + 1, now)).toBe(false);
    expect(progressRefresh(run({ done: 0 }), 0, now)).toBe(false);
    expect(progressRefresh(run({ done: 3, finished: true }), 0, now)).toBe(false); // metric_queries_finished does it
    expect(progressRefresh(run({ done: 3, kind: 'dashboard' }), 0, now)).toBe(false);
    expect(progressRefresh({ nope: true }, 0, now)).toBe(false);
  });
});
