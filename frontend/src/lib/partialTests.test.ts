import { describe, expect, it } from 'vitest';
import { describeTest, parsePartialTests } from './partialTests';

const FULL = JSON.stringify({ tests: [
  { column: 'id', test: 'unique', values: [], to: '', field: '', reason: 'PK {not} "quoted"' },
  { column: 'status', test: 'accepted_values', values: ['a', 'b]'], to: '', field: '', reason: 'enum' },
] });

describe('parsePartialTests', () => {
  it('reads complete elements', () => {
    const tests = parsePartialTests(FULL);
    expect(tests.map((t) => t.column)).toEqual(['id', 'status']);
    expect(tests[1].values).toEqual(['a', 'b]']);
  });

  it('only returns finished elements at any truncation point', () => {
    let last = 0;
    for (let n = 0; n <= FULL.length; n++) {
      const count = parsePartialTests(FULL.slice(0, n)).length;
      expect(count).toBeGreaterThanOrEqual(last);
      last = count;
    }
    expect(last).toBe(2);
    expect(parsePartialTests(FULL.slice(0, FULL.indexOf('status') - 5))).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(parsePartialTests('')).toEqual([]);
    expect(parsePartialTests('{"tests": [')).toEqual([]);
  });
});

describe('describeTest', () => {
  it('formats each kind', () => {
    expect(describeTest({ test: 'unique' })).toBe('unique');
    expect(describeTest({ test: 'accepted_values', values: ['a', 'b'] })).toBe('accepted_values [a, b]');
    expect(describeTest({ test: 'relationships', to: 'customers', field: 'id' })).toBe('relationships → customers.id');
  });
});
