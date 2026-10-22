import { describe, expect, it } from 'vitest';
import { relativeTime } from './relativeTime';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('relativeTime', () => {
  it.each([
    [2_000, 'just now'],
    [45_000, '45s ago'],
    [5 * 60_000, '5m ago'],
    [3 * 3_600_000, '3h ago'],
    [2 * 86_400_000, '2d ago'],
    [21 * 86_400_000, '3w ago'],
  ])('%i ms → %s', (ms, expected) => {
    expect(relativeTime(ago(ms), NOW)).toBe(expected);
  });

  it('treats future timestamps (clock skew) as just now', () => {
    expect(relativeTime(new Date(NOW + 5_000).toISOString(), NOW)).toBe('just now');
  });
});
