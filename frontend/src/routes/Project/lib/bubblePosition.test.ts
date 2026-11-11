import { describe, expect, it } from 'vitest';
import {
  EDGE_MARGIN, anchorFromRect, clampAnchor, clampOffset, isDrag, isOutside, parseAnchor, shiftRect,
} from './bubblePosition';

const VIEW = { width: 1000, height: 800 };

describe('anchorFromRect', () => {
  it('anchors to the nearest corner', () => {
    expect(anchorFromRect({ left: 900, top: 700, right: 930, bottom: 730 }, VIEW))
      .toEqual({ horizontal: 'right', x: 70, vertical: 'bottom', y: 70 });
    expect(anchorFromRect({ left: 20, top: 40, right: 50, bottom: 70 }, VIEW))
      .toEqual({ horizontal: 'left', x: 20, vertical: 'top', y: 40 });
    expect(anchorFromRect({ left: 100, top: 600, right: 130, bottom: 630 }, VIEW))
      .toEqual({ horizontal: 'left', x: 100, vertical: 'bottom', y: 170 });
  });
});

describe('clampAnchor', () => {
  it('keeps the bubble inside the window', () => {
    expect(clampAnchor({ horizontal: 'left', x: -40, vertical: 'top', y: 2000 }, VIEW, 30))
      .toEqual({ horizontal: 'left', x: EDGE_MARGIN, vertical: 'top', y: 800 - 30 - EDGE_MARGIN });
  });

  it('leaves an on-screen position alone', () => {
    const anchor = { horizontal: 'right', x: 70, vertical: 'bottom', y: 70 } as const;
    expect(clampAnchor(anchor, VIEW, 30)).toEqual(anchor);
  });
});

describe('isDrag', () => {
  it('ignores a jittery click', () => {
    expect(isDrag(2, 2)).toBe(false);
    expect(isDrag(4, 0)).toBe(true);
  });
});

describe('parseAnchor', () => {
  it('round-trips a stored anchor and rejects junk', () => {
    const anchor = { horizontal: 'left', x: 12, vertical: 'bottom', y: 40 };
    expect(parseAnchor(JSON.stringify(anchor))).toEqual(anchor);
    expect(parseAnchor(null)).toBeNull();
    expect(parseAnchor('not json')).toBeNull();
    expect(parseAnchor(JSON.stringify({ horizontal: 'middle', x: 1, vertical: 'top', y: 1 }))).toBeNull();
    expect(parseAnchor(JSON.stringify({ horizontal: 'left', x: 'a', vertical: 'top', y: 1 }))).toBeNull();
  });
});

describe('clampOffset', () => {
  const rect = { left: 900, top: 700, right: 930, bottom: 730 };

  it('stops the bubble EDGE_MARGIN from each edge however far the pointer goes', () => {
    expect(clampOffset(rect, { x: 500, y: 500 }, VIEW)).toEqual({ x: 1000 - EDGE_MARGIN - 930, y: 800 - EDGE_MARGIN - 730 });
    expect(clampOffset(rect, { x: -5000, y: -5000 }, VIEW)).toEqual({ x: EDGE_MARGIN - 900, y: EDGE_MARGIN - 700 });
    expect(shiftRect(rect, clampOffset(rect, { x: -5000, y: 0 }, VIEW)).left).toBe(EDGE_MARGIN);
  });

  it('passes a move that stays inside', () => {
    expect(clampOffset(rect, { x: -300, y: -200 }, VIEW)).toEqual({ x: -300, y: -200 });
  });
});

describe('isOutside', () => {
  it('flags a pointer past any edge', () => {
    expect(isOutside(500, 400, VIEW)).toBe(false);
    expect(isOutside(0, 0, VIEW)).toBe(false);
    expect(isOutside(-1, 400, VIEW)).toBe(true);
    expect(isOutside(500, 800, VIEW)).toBe(true);
    expect(isOutside(1000, 10, VIEW)).toBe(true);
  });
});
