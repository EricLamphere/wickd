import { describe, expect, it } from 'vitest';
import { nextSort, pruneSelection, sortRows, toggleAll, toggleSelection } from './richTable';

describe('sortRows', () => {
  const rows = [{ n: 'b', v: 2 }, { n: 'a', v: null }, { n: 'c', v: 10 }, { n: 'd', v: 2 }];

  it('sorts numbers either way, keeping ties stable and nulls last', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.n)).toEqual(['b', 'd', 'c', 'a']);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.n)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('sorts strings naturally and leaves order alone without a sort value', () => {
    const names = [{ n: 'model_10' }, { n: 'Model_2' }, { n: 'model_1' }];
    expect(sortRows(names, (r) => r.n, 'asc').map((r) => r.n)).toEqual(['model_1', 'Model_2', 'model_10']);
    expect(sortRows(names, undefined, 'asc')).toEqual(names);
  });
});

describe('nextSort', () => {
  it('starts a new column at its default and flips the same one', () => {
    expect(nextSort(null, 'score', 'desc')).toEqual({ id: 'score', dir: 'desc' });
    expect(nextSort({ id: 'score', dir: 'desc' }, 'score', 'desc')).toEqual({ id: 'score', dir: 'asc' });
    expect(nextSort({ id: 'score', dir: 'asc' }, 'name', 'asc')).toEqual({ id: 'name', dir: 'asc' });
  });
});

describe('selection', () => {
  const keys = ['a', 'b', 'c', 'd'];

  it('toggles one row, or a shift-click range to the clicked row’s new state', () => {
    expect([...toggleSelection(new Set(), keys, 'b', null)]).toEqual(['b']);
    expect([...toggleSelection(new Set(['a']), keys, 'c', 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...toggleSelection(new Set(['a', 'b', 'c', 'd']), keys, 'b', 'd')]).toEqual(['a']);
  });

  it('selects all visible rows, then clears them', () => {
    const all = toggleAll(new Set(['x']), keys);
    expect([...all].sort()).toEqual(['a', 'b', 'c', 'd', 'x']);
    expect([...toggleAll(all, keys)]).toEqual(['x']);
  });

  it('prunes keys that are gone, returning the same set when nothing changed', () => {
    const s = new Set(['a', 'z']);
    expect([...pruneSelection(s, keys)]).toEqual(['a']);
    const kept = new Set(['a']);
    expect(pruneSelection(kept, keys)).toBe(kept);
  });
});
