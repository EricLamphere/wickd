// Metric search box plus Model and Type filters: the Metrics sidebar, the dashboard builder's
// metrics rail and a widget's "Add a metric" picker all use it, so they filter the same way.
import { useMemo, useState, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import type { CatalogMetric } from '../../../lib/semanticApi';
import { FilterDropdown } from '../components/FilterDropdown';
import { EMPTY_SIDEBAR_FILTER, modelOptions, typeOptions, type SidebarFilter } from './lib/sidebarFilter';
import { NO_AUTOCORRECT } from './lib/searchInput';

/** Search + facet state for a metric list. */
export function useMetricFilter() {
  const [filter, setFilter] = useState<SidebarFilter>(EMPTY_SIDEBAR_FILTER);
  const update = (patch: Partial<SidebarFilter>) => setFilter((f) => ({ ...f, ...patch }));
  return { filter, update, reset: () => setFilter(EMPTY_SIDEBAR_FILTER) };
}

interface Props {
  metrics: readonly CatalogMetric[];
  filter: SidebarFilter;
  onChange: (patch: Partial<SidebarFilter>) => void;
  autoFocus?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  /** search box and filters on one row (wide headers) instead of stacked (rails, pickers) */
  row?: boolean;
}

export function MetricFilterBar({ metrics, filter, onChange, autoFocus, onKeyDown, className = '', row = false }: Props) {
  const models = useMemo(() => modelOptions(metrics), [metrics]);
  const types = useMemo(() => typeOptions(metrics), [metrics]);
  const faceted = filter.models.size > 0 || filter.types.size > 0;
  return (
    <div className={`flex gap-1.5 ${row ? 'flex-row flex-wrap items-center' : 'flex-col'} ${className}`}>
      <div className={`flex items-center gap-2 px-2 py-1.5 ${row ? 'w-72' : ''} bg-surface-app border border-gray-800 rounded focus-within:border-brand-600`}>
        <Search className="w-3.5 h-3.5 shrink-0 text-gray-500" />
        <input value={filter.search} onChange={(e) => onChange({ search: e.target.value })} onKeyDown={onKeyDown}
          placeholder="Search metrics" aria-label="Search metrics" autoFocus={autoFocus} {...NO_AUTOCORRECT}
          className="flex-1 min-w-0 bg-transparent text-xs text-gray-200 placeholder:text-gray-600 outline-none" />
        {filter.search && (
          <button type="button" onClick={() => onChange({ search: '' })} aria-label="Clear search" className="text-gray-500 hover:text-gray-300">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterDropdown label="Model" options={models} selected={filter.models} onChange={(next) => onChange({ models: next })} />
        <FilterDropdown label="Type" options={types} selected={filter.types} onChange={(next) => onChange({ types: next })} />
        {faceted && (
          <button type="button" onClick={() => onChange({ models: new Set(), types: new Set() })} title="Clear model and type filters"
            className="flex items-center gap-0.5 px-1 text-[11px] text-gray-500 hover:text-gray-300">
            <X className="w-3 h-3" />Clear
          </button>
        )}
      </div>
    </div>
  );
}
