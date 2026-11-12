// Pick one metric with the same search and Model / Type filters as the Metrics sidebar. Used
// wherever a metric is chosen: a widget's "Add a metric…", "Monitor a metric", Compare's
// "Pick a metric…". ↑/↓ move through the matches, Enter picks, Escape closes.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { SemanticCatalogDto } from '../../../lib/semanticApi';
import { TYPE_CLS } from './MetricsSidebar';
import { MetricFilterBar, useMetricFilter } from './MetricFilterBar';
import { filterMetrics } from './lib/sidebarFilter';

interface Props {
  catalog: SemanticCatalogDto;
  onPick: (metric: string) => void;
  /** the chosen metric, shown on the trigger ('select' variant) */
  value?: string | null;
  /** 'add': a dashed "+ placeholder" button; 'select': a field showing the choice */
  variant?: 'add' | 'select';
  placeholder?: string;
  /** metrics not offered (e.g. already on the widget) */
  exclude?: readonly string[];
  labels?: Map<string, string>;
  /** open as a floating popover under the trigger; otherwise in the flow (narrow rails, dialogs that clip) */
  popover?: boolean;
  ariaLabel?: string;
}

export function MetricChooser({
  catalog, onPick, value = null, variant = 'select', placeholder = 'Pick a metric…', exclude = [], labels, popover = false, ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const { filter, update, reset } = useMetricFilter();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(
    () => filterMetrics(catalog.metrics, filter).filter((m) => !exclude.includes(m.name)),
    [catalog.metrics, filter, exclude],
  );
  const labelOf = (name: string) => labels?.get(name) ?? catalog.metrics.find((m) => m.name === name)?.label ?? name;
  const chosen = value ? catalog.metrics.find((m) => m.name === value) : undefined;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const changeFilter = (patch: Parameters<typeof update>[0]) => { update(patch); setHighlight(0); };
  const show = () => { reset(); setHighlight(0); setOpen(true); };
  const pick = (name: string) => { onPick(name); setOpen(false); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { stop(); setOpen(false); }
    else if (e.key === 'ArrowDown') { stop(); setHighlight((h) => Math.min(h + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { stop(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && matches.length) { stop(); pick(matches[Math.min(highlight, matches.length - 1)].name); }
  };

  const trigger = variant === 'add' ? (
    <button type="button" onClick={() => (open ? setOpen(false) : show())} aria-label={ariaLabel}
      className="flex items-center gap-1 self-start px-2 py-1 text-xs rounded border border-dashed border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200">
      <Plus className="w-3 h-3" />{placeholder}
    </button>
  ) : (
    <button type="button" onClick={() => (open ? setOpen(false) : show())} aria-label={ariaLabel} aria-expanded={open}
      className="flex items-center gap-2 w-full min-w-[10rem] px-2 py-1.5 text-left text-xs rounded border border-gray-700 bg-surface-app hover:border-gray-600">
      <span className={`flex-1 min-w-0 truncate ${chosen ? 'text-gray-200' : 'text-gray-500'}`}>{chosen ? labelOf(chosen.name) : placeholder}</span>
      {chosen && <span className={`shrink-0 px-1 text-[9px] leading-4 rounded border ${TYPE_CLS[chosen.type] ?? TYPE_CLS.simple}`}>{chosen.type}</span>}
      <ChevronDown className="w-3 h-3 shrink-0 text-gray-500" />
    </button>
  );

  const panel = open && (
    <div className={`flex flex-col gap-1.5 p-1.5 rounded border border-gray-700 bg-surface-panel ${
      popover ? 'absolute left-0 top-full z-50 mt-1 w-80 max-w-[90vw] shadow-xl' : 'mt-1'}`}>
      <MetricFilterBar metrics={catalog.metrics} filter={filter} onChange={changeFilter} autoFocus onKeyDown={onKeyDown} />
      <div ref={listRef} className="max-h-56 overflow-y-auto" role="listbox" aria-label="Metrics">
        {matches.map((m, i) => (
          <button key={m.name} type="button" role="option" aria-selected={i === highlight} data-index={i}
            onClick={() => pick(m.name)} onMouseEnter={() => setHighlight(i)} title={m.description || m.name}
            className={`flex items-center gap-2 w-full px-2 py-1 text-left text-xs rounded ${i === highlight ? 'bg-gray-800/70' : ''}`}>
            <span className={`flex-1 min-w-0 truncate ${m.name === value ? 'text-brand-200' : 'text-gray-200'}`}>{labelOf(m.name)}</span>
            <span className={`shrink-0 px-1 text-[9px] leading-4 rounded border ${TYPE_CLS[m.type] ?? TYPE_CLS.simple}`}>{m.type}</span>
          </button>
        ))}
        {!matches.length && <p className="px-2 py-2 text-xs text-gray-500">No metrics match.</p>}
      </div>
    </div>
  );

  return <div ref={ref} className={`flex flex-col ${popover ? 'relative' : ''}`}>{trigger}{panel}</div>;
}
