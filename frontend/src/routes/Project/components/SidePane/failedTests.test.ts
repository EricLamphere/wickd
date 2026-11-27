import { describe, expect, it } from 'vitest';
import { failedTestsInSelection, isFailedTest, pickFailedTest } from './failedTests';

const node = (unique_id: string, resource_type: string, status: string) =>
  ({ unique_id, resource_type, status }) as Parameters<typeof isFailedTest>[0];

describe('failed tests in a DAG selection', () => {
  const a = node('test.a', 'test', 'error');
  const b = node('test.b', 'test', 'warn');
  const ok = node('test.ok', 'test', 'success');
  const model = node('model.m', 'model', 'error');

  it('counts only tests that errored or warned', () => {
    expect([a, b, ok, model].map(isFailedTest)).toEqual([true, true, false, false]);
  });

  it('lists the failed tests of a multi-selection in order, deduped', () => {
    expect(failedTestsInSelection([model, b, ok, a, b]).map((n) => n.unique_id)).toEqual(['test.b', 'test.a']);
  });

  it('is empty for a single selection', () => {
    expect(failedTestsInSelection([a])).toEqual([]);
    expect(failedTestsInSelection([])).toEqual([]);
  });

  it('keeps the picked test while listed, else falls back to the first', () => {
    expect(pickFailedTest([a, b], 'test.b')).toBe('test.b');
    expect(pickFailedTest([a, b], 'test.gone')).toBe('test.a');
    expect(pickFailedTest([a, b], null)).toBe('test.a');
    expect(pickFailedTest([], 'test.a')).toBeNull();
  });
});
