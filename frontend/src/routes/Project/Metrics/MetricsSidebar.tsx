// Left column of the Metrics page: metrics grouped by semantic model, then saved queries.
import { useMemo, useState } from 'react';
import { Bookmark, Check, LayoutGrid, Pencil, Search } from 'lucide-react';
import type { CatalogMetric, CatalogSavedQuery, SemanticCatalogDto } from '../../../lib/semanticApi';
import { OPEN_IN_FILES_TITLE, isOpenInFilesClick } from '../lib/openInFiles';

/** Type pill colors per metric type (also the metric index and pages). */
export const TYPE_CLS: Record<string, string> = {
  simple: 'bg-gray-800 text-gray-400 border-gray-700',
  ratio: 'bg-purple-950/40 text-purple-300 border-purple-900/60',
  cumulative: 'bg-sky-950/40 text-sky-300 border-sky-900/60',
  derived: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  conversion: 'bg-rose-950/40 text-rose-300 border-rose-900/60',
};

interface Props {
  catalog: SemanticCatalogDto;
  selected: string[];
  savedQuery: string | null;
  onToggleMetric: (name: string) => void;
  onRunSaved: (q: CatalogSavedQuery) => void;
  onEditSaved: (q: CatalogSavedQuery) => void;
  /** Cmd+click: open the metric's YAML (null when it isn't in the manifest graph) */
  onOpenYaml: ((metric: string) => void) | null;
  /** the metric index (plan 13); `indexActive` while it's shown */
  onShowIndex: () => void;
  indexActive: boolean;
}

function matches(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

function groupByModel(metrics: CatalogMetric[]): [string, CatalogMetric[]][] {
  const groups = new Map<string, CatalogMetric[]>();
  for (const m of metrics) {
    const model = m.semantic_models.length === 1 ? m.semantic_models[0] : m.semantic_models.length ? 'Across models' : 'Other';
    groups.set(model, [...(groups.get(model) ?? []), m]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function MetricsSidebar({ catalog, selected, savedQuery, onToggleMetric, onRunSaved, onEditSaved, onOpenYaml, onShowIndex, indexActive }: Props) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const metrics = useMemo(
    () => catalog.metrics.filter((m) => !needle || matches(m.name, needle) || matches(m.label ?? '', needle)),
    [catalog.metrics, needle],
  );
  const saved = catalog.saved_queries.filter((q) => !needle || matches(q.name, needle) || matches(q.label ?? '', needle));

  return (
    <aside className="flex flex-col w-64 shrink-0 border-r border-gray-800 bg-surface-panel min-h-0">
      <button onClick={onShowIndex} className={`flex items-center gap-2 mx-2 mt-2 px-2 py-1.5 text-xs rounded text-left ${
        indexActive ? 'bg-brand-950/40 text-brand-200' : 'text-gray-300 hover:bg-gray-800/60'}`}>
        <LayoutGrid className="w-3.5 h-3.5" />All metrics
      </button>
      <label className="flex items-center gap-2 m-2 px-2 py-1.5 bg-surface-app border border-gray-800 rounded focus-within:border-brand-600">
        <Search className="w-3.5 h-3.5 text-gray-500" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search metrics"
          className="flex-1 min-w-0 bg-transparent text-xs text-gray-200 placeholder:text-gray-600 outline-none" />
      </label>
      <div className="flex-1 overflow-y-auto pb-4">
        {groupByModel(metrics).map(([model, items]) => (
          <section key={model} className="mb-2">
            <h3 className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">{model}</h3>
            {items.map((m) => {
              const on = selected.includes(m.name);
              return (
                <button
                  key={m.name}
                  onClick={(e) => (isOpenInFilesClick(e) && onOpenYaml ? onOpenYaml(m.name) : onToggleMetric(m.name))}
                  title={[m.description, onOpenYaml ? OPEN_IN_FILES_TITLE : ''].filter(Boolean).join('\n')}
                  className={`flex items-center gap-2 w-full px-3 py-1 text-left text-xs transition-colors ${
                    on ? 'bg-brand-950/40 text-brand-200' : 'text-gray-300 hover:bg-gray-800/60'}`}
                >
                  <span className={`w-3.5 h-3.5 shrink-0 flex items-center justify-center rounded-sm border ${
                    on ? 'bg-brand-600 border-brand-600 text-white' : 'border-gray-600'}`}>
                    {on && <Check className="w-3 h-3" />}
                  </span>
                  <span className="flex-1 truncate">{m.label || m.name}</span>
                  <span className={`px-1 text-[9px] leading-4 rounded border ${TYPE_CLS[m.type] ?? TYPE_CLS.simple}`}>{m.type}</span>
                </button>
              );
            })}
          </section>
        ))}
        {metrics.length === 0 && <p className="px-3 py-2 text-xs text-gray-500">No metrics match.</p>}

        {saved.length > 0 && (
          <section className="mt-3">
            <h3 className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Saved queries</h3>
            {saved.map((q) => (
              <div key={q.name} className={`group flex items-center gap-2 px-3 py-1 text-xs ${
                savedQuery === q.name ? 'bg-brand-950/40 text-brand-200' : 'text-gray-300 hover:bg-gray-800/60'}`}>
                <button onClick={() => onRunSaved(q)} title={q.description || `Run ${q.name}`} className="flex flex-1 min-w-0 items-center gap-2 text-left">
                  <Bookmark className="w-3.5 h-3.5 shrink-0 text-gray-500" />
                  <span className="truncate">{q.label || q.name}</span>
                </button>
                <button onClick={() => onEditSaved(q)} title="Open in the query builder to change it"
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200">
                  <Pencil className="w-3 h-3" />
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  );
}
