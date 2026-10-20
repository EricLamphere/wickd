import { describe, expect, it } from 'vitest';
import { parsePartialDocs } from './partialDocs';

const FULL = '{"description": "One row per customer.", "columns": {"id": "Customer key.", "ltv": "Lifetime value \\"net\\" of returns."}}';

describe('parsePartialDocs', () => {
  it('reads a complete answer', () => {
    expect(parsePartialDocs(FULL)).toEqual({
      description: 'One row per customer.',
      columns: [
        { name: 'id', description: 'Customer key.', done: true },
        { name: 'ltv', description: 'Lifetime value "net" of returns.', done: true },
      ],
    });
  });

  it('handles every truncation point without throwing', () => {
    for (let n = 0; n <= FULL.length; n++) {
      const partial = parsePartialDocs(FULL.slice(0, n));
      expect(partial.columns.length).toBeLessThanOrEqual(2);
    }
  });

  it('shows a description while it is being written', () => {
    const partial = parsePartialDocs('{"description": "One row per cus');
    expect(partial.description).toBe('One row per cus');
    expect(partial.columns).toEqual([]);
  });

  it('marks the column being written as not done', () => {
    const partial = parsePartialDocs('{"description": "x", "columns": {"id": "Customer key.", "ltv": "Lifeti');
    expect(partial.columns).toEqual([
      { name: 'id', description: 'Customer key.', done: true },
      { name: 'ltv', description: 'Lifeti', done: false },
    ]);
  });

  it('drops a half-written escape', () => {
    expect(parsePartialDocs('{"description": "a \\').description).toBe('a ');
  });

  it('returns nothing for empty input', () => {
    expect(parsePartialDocs('')).toEqual({ description: null, columns: [] });
  });
});
