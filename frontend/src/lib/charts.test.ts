import { describe, expect, it } from 'vitest';
import { areaPath, linePath, median, nearestIndex, niceMax, plotPoints } from './charts';

describe('charts', () => {
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('niceMax rounds up to a readable axis top', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(42)).toBe(50);
    expect(niceMax(180)).toBe(200);
    expect(niceMax(2.1)).toBe(2.5);
  });

  it('plots values into the box, top = max, clamped', () => {
    const pts = plotPoints([0, 5, 10], 100, 20, 0);
    expect(pts).toEqual([{ x: 0, y: 20 }, { x: 50, y: 10 }, { x: 100, y: 0 }]);
    expect(plotPoints([30], 100, 20, 0, 10)).toEqual([{ x: 50, y: 0 }]);
    expect(plotPoints([], 100, 20)).toEqual([]);
  });

  it('builds line and area paths and finds the nearest point', () => {
    const pts = [{ x: 0, y: 5 }, { x: 10, y: 0 }];
    expect(linePath(pts)).toBe('M0,5 L10,0');
    expect(areaPath(pts, 20)).toBe('M0,5 L10,0 L10,20 L0,20 Z');
    expect(nearestIndex(pts, 7)).toBe(1);
    expect(nearestIndex(pts, 2)).toBe(0);
  });
});
