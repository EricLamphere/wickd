import { describe, expect, it } from 'vitest';
import { anyRunning, endRun, isRunning, newRunId, NO_RUNS, startRun } from './runningWidgets';

describe('running widgets', () => {
  it('tracks each run on its own, so one finishing leaves the others running', () => {
    const runA = newRunId();
    const runB = newRunId();
    const a = startRun(NO_RUNS, runA, ['w1', 'w2']);
    const b = startRun(a, runB, ['w3']);
    expect(isRunning(b, 'w1') && isRunning(b, 'w3')).toBe(true);
    const afterA = endRun(b, runA);
    expect(isRunning(afterA, 'w1')).toBe(false);
    expect(isRunning(afterA, 'w3')).toBe(true); // the new widget's run is still going
    expect(anyRunning(endRun(afterA, runB))).toBe(false);
  });

  it('treats a run without ids as every widget', () => {
    const runs = startRun(NO_RUNS, newRunId(), undefined);
    expect(isRunning(runs, 'anything')).toBe(true);
    expect(anyRunning(runs)).toBe(true);
  });

  it('never mutates the previous state', () => {
    const id = newRunId();
    const runs = startRun(NO_RUNS, id, ['w1']);
    endRun(runs, id);
    expect(isRunning(runs, 'w1')).toBe(true);
    expect(NO_RUNS).toHaveLength(0);
  });
});
