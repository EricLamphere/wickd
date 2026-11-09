import { describe, expect, it } from 'vitest';
import { findUnitTestLine } from './unitTestLine';

const YAML = `version: 2
models:
  - name: orders_state
unit_tests:
  - name: other
    model: orders
  - name: "orders_state"
    model: orders
- name: zero_offset
sources: []
`;

describe('findUnitTestLine', () => {
  it('finds the entry under unit_tests, not a model of the same name', () => {
    expect(findUnitTestLine(YAML, 'orders_state')).toBe(7);
    expect(findUnitTestLine(YAML, 'other')).toBe(5);
    expect(findUnitTestLine(YAML, 'zero_offset')).toBe(9);
  });

  it('falls back to anywhere, else null', () => {
    expect(findUnitTestLine('models:\n  - name: x\n', 'x')).toBe(2);
    expect(findUnitTestLine(YAML, 'missing')).toBeNull();
  });
});
