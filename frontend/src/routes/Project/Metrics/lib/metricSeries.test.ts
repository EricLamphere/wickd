import { describe, expect, it } from 'vitest';
import { formatTime, formatValue, parseTime } from './metricSeries';

const JAN1 = Date.UTC(2026, 0, 1);

describe('parseTime', () => {
  it('reads dates and naive timestamps as UTC', () => {
    expect(parseTime('2026-01-01')).toBe(JAN1);
    expect(parseTime('2026-01-01 00:00:00')).toBe(JAN1);
    expect(parseTime('2026-01-01T00:00:00')).toBe(JAN1);
    expect(parseTime('2026-01-01T01:00:00+01:00')).toBe(JAN1);
    expect(parseTime(null)).toBeNull();
    expect(parseTime('nope')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats values and time ticks', () => {
    expect(formatValue(12_345)).toMatch(/12\.3K/i);
    expect(formatValue(0.01234)).toBe('0.0123');
    expect(formatValue(null)).toBe('–');
    expect(formatTime(JAN1, 'quarter')).toBe('Q1 2026');
    expect(formatTime(JAN1, 'month')).toBe('Jan 2026');
    expect(formatTime(JAN1, 'day')).toBe('Jan 1, 2026');
  });
});
