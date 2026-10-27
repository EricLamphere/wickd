import { Fragment, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import {
  nextSort, sortRows, toggleAll, toggleSelection, type SortDir, type SortState, type SortValue,
} from '../lib/richTable';

export interface RichColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable. */
  sortValue?: (row: T) => SortValue;
  /** Direction on first click (numbers usually want 'desc'). */
  defaultDir?: SortDir;
  align?: 'left' | 'right' | 'center';
  /** Tailwind width class, e.g. 'w-24' (the table is fixed-layout: columns without one share the rest). */
  width?: string;
  headerTitle?: string;
}

export interface RichSelection {
  selected: ReadonlySet<string>;
  onChange: (selected: Set<string>) => void;
}

interface RichTableProps<T> {
  rows: readonly T[];
  columns: RichColumn<T>[];
  rowKey: (row: T) => string;
  initialSort?: SortState;
  /** Checkbox per row (shift-click selects a range). */
  selection?: RichSelection;
  /** Details shown under a row when it's expanded (click the row, or Enter). */
  renderExpanded?: (row: T) => ReactNode;
  /** Buttons revealed at the end of a row on hover / focus. */
  rowActions?: (row: T) => ReactNode;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  ariaLabel: string;
  /** Width class of the row-actions column (fits its buttons). */
  actionsWidth?: string;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/**
 * A designed table for Pro insight views (Run History performance, Test gaps):
 * cells are components, columns sort, rows select / expand / carry actions, and
 * the keyboard works (↑/↓ move, Space selects, Enter or →/← expands).
 * Raw query results and data grids still use DataTable.
 */
export function RichTable<T>({
  rows, columns, rowKey, initialSort, selection, renderExpanded, rowActions, empty, ariaLabel, actionsWidth = 'w-20',
}: RichTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const lastClicked = useRef<string | null>(null);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sort?.id);
    return sortRows(rows, col?.sortValue, sort?.dir ?? 'asc');
  }, [rows, columns, sort]);
  const keys = useMemo(() => sorted.map(rowKey), [sorted, rowKey]);

  const toggleExpanded = (key: string, open?: boolean) => {
    if (!renderExpanded) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !next.has(key);
      if (want) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const check = (key: string, shift: boolean) => {
    if (!selection) return;
    selection.onChange(toggleSelection(selection.selected, keys, key, shift ? lastClicked.current : null));
    lastClicked.current = key;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('button, a, input')) return;
    const index = active === null ? -1 : keys.indexOf(active);
    const move = (to: number) => {
      e.preventDefault();
      const key = keys[Math.max(0, Math.min(keys.length - 1, to))];
      if (key) setActive(key);
    };
    if (e.key === 'ArrowDown') move(index + 1);
    else if (e.key === 'ArrowUp') move(index - 1);
    else if (active && e.key === ' ' && selection) { e.preventDefault(); check(active, e.shiftKey); }
    else if (active && (e.key === 'Enter' || e.key === 'ArrowRight')) { e.preventDefault(); toggleExpanded(active, e.key === 'ArrowRight' ? true : undefined); }
    else if (active && e.key === 'ArrowLeft') { e.preventDefault(); toggleExpanded(active, false); }
  };

  const allOn = selection && keys.length > 0 && keys.every((k) => selection.selected.has(k));
  const someOn = selection && keys.some((k) => selection.selected.has(k));
  const span = columns.length + (selection ? 1 : 0) + (renderExpanded ? 1 : 0) + (rowActions ? 1 : 0);

  return (
    <div
      role="grid"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="rounded-xl border border-gray-800 bg-surface-panel overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-brand-600/60"
    >
      <table className="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr className="border-b border-gray-800 bg-surface-elevated/40">
            {selection && (
              <th className="w-9 pl-3.5 pr-1 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={!!allOn}
                  ref={(el) => { if (el) el.indeterminate = !allOn && !!someOn; }}
                  onChange={() => selection.onChange(toggleAll(selection.selected, keys))}
                  className="align-middle accent-brand-500 cursor-pointer"
                />
              </th>
            )}
            {renderExpanded && <th className="w-6" aria-hidden />}
            {columns.map((col) => {
              const sorted = sort?.id === col.id;
              const Arrow = sort?.dir === 'asc' ? ArrowUp : ArrowDown;
              return (
                <th
                  key={col.id}
                  title={col.headerTitle}
                  aria-sort={sorted ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap ${ALIGN[col.align ?? 'left']} ${col.width ?? ''}`}
                >
                  {col.sortValue ? (
                    <button
                      type="button"
                      onClick={() => setSort((s) => nextSort(s, col.id, col.defaultDir ?? 'asc'))}
                      className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-gray-200 transition-colors ${sorted ? 'text-gray-200' : ''}`}
                    >
                      {col.header}
                      <Arrow size={10} className={sorted ? 'opacity-100' : 'opacity-0'} />
                    </button>
                  ) : col.header}
                </th>
              );
            })}
            {rowActions && <th className={actionsWidth} aria-hidden />}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={span} className="px-4 py-10 text-center text-gray-500">{empty ?? 'Nothing to show.'}</td></tr>
          )}
          {sorted.map((row) => {
            const key = rowKey(row);
            const isOpen = expanded.has(key);
            const isSelected = !!selection?.selected.has(key);
            const onRowClick = (e: MouseEvent) => {
              setActive(key);
              if ((e.target as HTMLElement).closest('button, a, input')) return;
              if (e.metaKey || e.ctrlKey || window.getSelection()?.toString()) return;
              toggleExpanded(key);
            };
            return (
              <Fragment key={key}>
                <tr
                  aria-selected={isSelected}
                  aria-expanded={renderExpanded ? isOpen : undefined}
                  onClick={onRowClick}
                  className={`group border-b border-gray-800/60 last:border-b-0 transition-colors ${
                    renderExpanded ? 'cursor-pointer' : ''
                  } ${isSelected ? 'bg-brand-950/30' : active === key ? 'bg-surface-elevated/50' : 'hover:bg-surface-elevated/40'}`}
                >
                  {selection && (
                    <td className="w-9 pl-3.5 pr-1 py-2.5" onClick={(e) => { e.stopPropagation(); check(key, e.shiftKey); }}>
                      <input
                        type="checkbox"
                        aria-label="Select row"
                        checked={isSelected}
                        readOnly
                        className="align-middle accent-brand-500 cursor-pointer pointer-events-none"
                      />
                    </td>
                  )}
                  {renderExpanded && (
                    <td className="w-6 pl-1 text-gray-600">
                      <ChevronRight size={13} className={`transition-transform ${isOpen ? 'rotate-90 text-gray-300' : ''}`} />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.id} className={`px-3 py-2.5 align-middle overflow-hidden ${ALIGN[col.align ?? 'left']}`}>
                      {col.cell(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td className="pr-2 py-1.5 text-right whitespace-nowrap">
                      <span className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                        {rowActions(row)}
                      </span>
                    </td>
                  )}
                </tr>
                {renderExpanded && isOpen && (
                  <tr className="border-b border-gray-800/60 bg-surface-app/60">
                    <td colSpan={span} className="px-4 py-3">{renderExpanded(row)}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
