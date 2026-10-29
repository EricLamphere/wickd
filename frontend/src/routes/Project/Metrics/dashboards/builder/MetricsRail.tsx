// Left rail: every metric (grouped by semantic model) and saved query. Drag one onto the
// canvas to start a widget, or onto a widget to add it there; click adds it to the selected
// widget (or starts a new one). Metrics already on the dashboard are marked, and with Pro a
// dot shows their monitor status.
import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Bookmark, ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { SemanticCatalogDto } from '../../../../../lib/semanticApi';
import { statusStyle, type MetricMonitorState } from '../../monitors/monitorView';
import { FloatingRail, type Rail } from './RailResize';

export type RailItem = { kind: 'metric'; name: string } | { kind: 'saved'; name: string };

interface Props {
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  inUse: Set<string>;
  monitorStatuses: Map<string, MetricMonitorState>;
  onAdd: (item: RailItem) => void;
  rail: Rail;
}

function Item({ item, label, type, used, monitor, onAdd }: {
  item: RailItem; label: string; type?: string; used: boolean; monitor?: MetricMonitorState; onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `${item.kind}:${item.name}`, data: item });
  const dot = monitor?.status ? statusStyle(monitor.status) : null;
  return (
    <button ref={setNodeRef} {...attributes} {...listeners} type="button" onClick={onAdd}
      title={`${label} — drag onto the dashboard, or click to add`}
      className={`flex items-center gap-1.5 w-full px-2 py-1 text-left text-xs rounded cursor-grab hover:bg-gray-800/70 ${isDragging ? 'opacity-40' : ''}`}>
      {item.kind === 'saved' ? <Bookmark className="w-3 h-3 shrink-0 text-gray-500" />
        : <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${used ? 'bg-brand-400' : 'bg-gray-700'}`} title={used ? 'On this dashboard' : undefined} />}
      <span className={`flex-1 min-w-0 truncate ${used ? 'text-gray-100' : 'text-gray-300'}`}>{label}</span>
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot.dot}`} title={`Monitor: ${monitor?.headline}`} />}
      {type && <span className="shrink-0 text-[9px] uppercase tracking-wide text-gray-600">{type}</span>}
    </button>
  );
}

export function MetricsRail({ catalog, labels, inUse, monitorStatuses, onAdd, rail }: Props) {
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (name: string, label?: string | null) => !q || name.toLowerCase().includes(q) || !!label?.toLowerCase().includes(q);
    const byModel = new Map<string, SemanticCatalogDto['metrics']>();
    for (const m of catalog.metrics) {
      if (!match(m.name, m.label)) continue;
      const group = m.semantic_models[0] ?? 'Derived metrics';
      byModel.set(group, [...(byModel.get(group) ?? []), m]);
    }
    return [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog, query]);
  const saved = catalog.saved_queries.filter((s) => !query.trim() || s.name.includes(query.trim().toLowerCase()));
  const toggle = (g: string) => setClosed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; });

  return (
    <FloatingRail side="left" rail={rail}>
      <div className="px-3 pt-3 pb-2">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Metrics</h2>
        <label className="flex items-center gap-1.5 px-2 py-1 rounded border border-gray-700 bg-surface-app">
          <Search className="w-3 h-3 text-gray-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search metrics"
            className="flex-1 min-w-0 bg-transparent text-xs text-gray-200 outline-none placeholder-gray-600" />
        </label>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-1.5 pb-3">
        {groups.map(([group, metrics]) => (
          <section key={group} className="mb-1">
            <button type="button" onClick={() => toggle(group)}
              className="flex items-center gap-1 w-full px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-300">
              {closed.has(group) ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              <span className="truncate">{group}</span>
            </button>
            {!closed.has(group) && metrics.map((m) => (
              <Item key={m.name} item={{ kind: 'metric', name: m.name }} label={labels.get(m.name) ?? m.name} type={m.type}
                used={inUse.has(m.name)} monitor={monitorStatuses.get(m.name)} onAdd={() => onAdd({ kind: 'metric', name: m.name })} />
            ))}
          </section>
        ))}
        {saved.length > 0 && (
          <section className="mt-2">
            <h3 className="px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Saved queries</h3>
            {saved.map((s) => (
              <Item key={s.name} item={{ kind: 'saved', name: s.name }} label={s.label || s.name} used={false}
                onAdd={() => onAdd({ kind: 'saved', name: s.name })} />
            ))}
          </section>
        )}
        {!groups.length && !saved.length && <p className="px-2 py-4 text-xs text-gray-500">No metrics match.</p>}
      </div>
      <p className="px-3 py-2 text-[10px] text-gray-500 border-t border-gray-800">
        Drag onto empty space for a new widget, or onto a widget to add it.
      </p>
    </FloatingRail>
  );
}
