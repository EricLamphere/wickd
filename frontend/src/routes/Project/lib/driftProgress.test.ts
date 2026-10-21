import { describe, expect, it } from 'vitest';
import { driftProgressLabel } from './driftProgress';

describe('driftProgressLabel', () => {
  it('shows the batch being checked', () => {
    expect(driftProgressLabel({ checked: 25, total: 120, current: '', batch_start: 26, batch_end: 50 }))
      .toBe('Checking 26–50 of 120…');
  });

  it('names the model when checking one at a time', () => {
    expect(driftProgressLabel({ checked: 27, total: 120, current: 'orders', batch_start: 26, batch_end: 50 }))
      .toBe('Checking 26–50 of 120 — orders…');
  });

  it('shows a single number for a one-model batch', () => {
    expect(driftProgressLabel({ checked: 120, total: 121, current: '', batch_start: 121, batch_end: 121 }))
      .toBe('Checking 121 of 121…');
  });

  it('falls back to a count without batch info (e.g. after a reload)', () => {
    expect(driftProgressLabel({ checked: 50, total: 120, current: '' })).toBe('Checking 50 / 120…');
  });
});
