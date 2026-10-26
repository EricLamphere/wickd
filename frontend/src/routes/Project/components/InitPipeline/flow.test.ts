import { describe, expect, it } from 'vitest';
import { TILE_WIDTH_PCT, connectorState, laneCenterPct, laneOffsetPct, seedStepStates } from './flow';

describe('laneOffsetPct', () => {
  it('waves left → right → left and repeats', () => {
    expect([0, 1, 2, 3, 4, 5].map(laneOffsetPct)).toEqual([0, 11, 22, 11, 0, 11]);
  });

  it('keeps every tile inside the column', () => {
    for (let i = 0; i < 8; i++) {
      expect(laneOffsetPct(i) + TILE_WIDTH_PCT).toBeLessThanOrEqual(100);
    }
  });
});

describe('laneCenterPct', () => {
  it('is the offset plus half the tile width', () => {
    expect(laneCenterPct(0)).toBe(TILE_WIDTH_PCT / 2);
    expect(laneCenterPct(2)).toBe(22 + TILE_WIDTH_PCT / 2);
  });
});

describe('connectorState', () => {
  it('is active whenever the downstream step is running', () => {
    expect(connectorState('success', 'running')).toBe('active');
    expect(connectorState('idle', 'running')).toBe('active');
  });

  it('follows the upstream result otherwise', () => {
    expect(connectorState('success', 'idle')).toBe('done');
    expect(connectorState('success', 'success')).toBe('done');
    expect(connectorState('error', 'idle')).toBe('failed');
  });

  it('is idle before anything ran or while upstream is still running', () => {
    expect(connectorState('idle', 'idle')).toBe('idle');
    expect(connectorState('running', 'idle')).toBe('idle');
  });
});

describe('seedStepStates', () => {
  const step = (name: string, last_status: string, run_state: 'pending' | 'running' | 'success' | 'error' | null = null) => ({
    name, last_status, last_log: `${name} log`, last_finished_at: '2026-10-26T12:00:00', run_state,
  });

  it('shows how each step last finished when nothing is running', () => {
    const { states, running } = seedStepStates([step('a', 'success'), step('b', 'error'), step('c', 'idle')]);
    expect(running).toBe(false);
    expect(states).toEqual({
      a: { status: 'success', log: 'a log', finishedAt: '2026-10-26T12:00:00' },
      b: { status: 'error', log: 'b log', finishedAt: '2026-10-26T12:00:00' },
    });
  });

  it('mid-run: done steps keep their status, the current one runs, the rest are idle', () => {
    const { states, running } = seedStepStates([
      step('a', 'success', 'success'),
      step('b', 'running', 'running'),
      step('c', 'error', 'pending'), // failed last time, not reached yet this time
      step('d', 'success', null), // not part of this run (disabled)
    ]);
    expect(running).toBe(true);
    expect(states.a.status).toBe('success');
    expect(states.b).toEqual({ status: 'running', log: '', finishedAt: null });
    expect(states.c).toBeUndefined();
    expect(states.d.status).toBe('success');
  });
});
