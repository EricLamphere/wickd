import { describe, expect, it } from 'vitest';
import { TILE_WIDTH_PCT, connectorState, laneCenterPct, laneOffsetPct } from './flow';

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
