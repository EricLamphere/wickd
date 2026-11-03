import { describe, expect, it } from 'vitest';
import { clickDay, previewRange } from './rangeClicks';

const d = (day: number) => new Date(2026, 9, day);

describe('rangeClicks', () => {
  it('the first click only picks one end', () => {
    expect(clickDay(null, d(10))).toEqual({ pending: d(10), range: null });
  });

  it('the second click finishes the range, earlier day first', () => {
    expect(clickDay(d(10), d(20))).toEqual({ pending: null, range: { from: d(10), to: d(20) } });
    expect(clickDay(d(20), d(10))).toEqual({ pending: null, range: { from: d(10), to: d(20) } });
    expect(clickDay(d(15), d(15))).toEqual({ pending: null, range: { from: d(15), to: d(15) } });
  });

  it('previews to the hovered day while waiting for the second click', () => {
    expect(previewRange(null, d(3))).toBeNull();
    expect(previewRange(d(10), null)).toEqual({ from: d(10), to: undefined });
    expect(previewRange(d(10), d(4))).toEqual({ from: d(4), to: d(10) });
  });
});
