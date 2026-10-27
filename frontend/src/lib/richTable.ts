/** Pure helpers for components/RichTable.tsx: sorting and checkbox selection. */

export type SortDir = 'asc' | 'desc';
export interface SortState {
  id: string;
  dir: SortDir;
}
export type SortValue = number | string | null | undefined;

/** Rows sorted by `value` (stable; nulls last in either direction). */
export function sortRows<T>(rows: readonly T[], value: ((row: T) => SortValue) | undefined, dir: SortDir): T[] {
  if (!value) return [...rows];
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      const aNull = a.v === null || a.v === undefined;
      const bNull = b.v === null || b.v === undefined;
      if (aNull || bNull) return aNull === bNull ? a.index - b.index : aNull ? 1 : -1;
      const cmp = typeof a.v === 'number' && typeof b.v === 'number'
        ? a.v - b.v
        : String(a.v).localeCompare(String(b.v), undefined, { numeric: true, sensitivity: 'base' });
      return cmp === 0 ? a.index - b.index : cmp * sign;
    })
    .map((x) => x.row);
}

/** Clicking a header: a new column starts at its default direction, the same column flips. */
export function nextSort(current: SortState | null, id: string, defaultDir: SortDir): SortState {
  if (current?.id !== id) return { id, dir: defaultDir };
  return { id, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/**
 * Toggle `key`'s checkbox. With `rangeFrom` (shift-click), every row between the
 * last-clicked row and this one takes this row's new state.
 */
export function toggleSelection(
  selected: ReadonlySet<string>,
  orderedKeys: readonly string[],
  key: string,
  rangeFrom: string | null,
): Set<string> {
  const next = new Set(selected);
  const checked = !selected.has(key);
  const from = rangeFrom === null ? -1 : orderedKeys.indexOf(rangeFrom);
  const to = orderedKeys.indexOf(key);
  const keys = from >= 0 && to >= 0
    ? orderedKeys.slice(Math.min(from, to), Math.max(from, to) + 1)
    : [key];
  for (const k of keys) {
    if (checked) next.add(k);
    else next.delete(k);
  }
  return next;
}

/** Header checkbox: select every visible row, or clear them if all are selected. */
export function toggleAll(selected: ReadonlySet<string>, visibleKeys: readonly string[]): Set<string> {
  const allOn = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
  const next = new Set(selected);
  for (const k of visibleKeys) {
    if (allOn) next.delete(k);
    else next.add(k);
  }
  return next;
}

/** Drop selected keys that are no longer rows (after a refetch or filter change of the data). */
export function pruneSelection(selected: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const present = new Set(keys);
  const next = new Set([...selected].filter((k) => present.has(k)));
  return next.size === selected.size ? (selected as Set<string>) : next;
}
