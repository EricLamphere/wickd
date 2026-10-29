import { describe, expect, it } from 'vitest';
import { edgeSpeed } from './drag';

describe('edgeSpeed', () => {
  it('scrolls only near or past an edge, faster further out, capped', () => {
    expect(edgeSpeed(500, 0, 1000)).toBe(0);
    expect(edgeSpeed(980, 0, 1000)).toBeGreaterThan(0);
    expect(edgeSpeed(1100, 0, 1000)).toBeGreaterThan(edgeSpeed(980, 0, 1000));
    expect(edgeSpeed(5000, 0, 1000)).toBe(10);
    expect(edgeSpeed(10, 0, 1000)).toBeLessThan(0);
    expect(edgeSpeed(-500, 0, 1000)).toBe(-10);
  });
});
