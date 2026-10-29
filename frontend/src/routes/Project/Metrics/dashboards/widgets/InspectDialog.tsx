// "Drill into…" a value: draft widgets filtered to it — a metric summary beside a horizontal bar
// chart by the first shared dimension no filter uses, and a table by period below. Click a widget to configure it in the side pane with every setting a dashboard
// widget has; Add to dashboard inserts the chosen ones (as configured) after the source widget.
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Filter, X } from 'lucide-react';
import type { DashboardDoc, DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../../lib/semanticApi';
import { rangeLabel, sharedDimensions, widgetInfo } from '../dashboardModel';
import { breakdownDimension, DRILLED_CHARTS, drilledWidgets, pickFilters, pickLabel, type DrilledChart, type Pick } from '../drill';
import { errorText } from '../useDashboards';
import { WidgetSettings } from '../builder/WidgetSettings';
import { AddDrilledMenu } from './AddDrilledMenu';
import { DraftSlot } from './DraftSlot';
import { useWidgetPreview } from './useWidgetPreview';
import type { ValueActions } from './ValueMenu';

interface Props {
  projectId: number;
  slug: string;
  doc: DashboardDoc;
  widget: DashboardWidget;
  result: WidgetResultDto;
  pick: Pick;
  labels: Map<string, string>;
  catalog: SemanticCatalogDto;
  actions: Omit<ValueActions, 'onInspect' | 'onDrill'>;
  /** the chosen draft widgets onto the dashboard (absent while presenting) */
  onAddToDashboard: ((widgets: DashboardWidget[]) => void) | null;
  onClose: () => void;
}

const TOP_PX = 300;
const TABLE_PX = 320;

type Drafts = Partial<Record<DrilledChart, DashboardWidget>>;

export function InspectDialog({ projectId, slug, doc, widget, result, pick, labels, catalog, actions, onAddToDashboard, onClose }: Props) {
  const [drafts, setDrafts] = useState<Drafts>(() => {
    const filters = [...(doc.filters ?? []), ...(widget.filters ?? []), ...pickFilters(pick)];
    const dimension = breakdownDimension(sharedDimensions(catalog, widget.metrics ?? []), filters);
    return drilledWidgets(widget, pick, DRILLED_CHARTS, dimension, labels);
  });
  const [selected, setSelected] = useState<DrilledChart | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pane = useRef<HTMLElement>(null);
  const previews = {
    summary: useWidgetPreview(projectId, slug, drafts.summary ?? null),
    breakdown: useWidgetPreview(projectId, slug, drafts.breakdown ?? null),
    table: useWidgetPreview(projectId, slug, drafts.table ?? null),
  };
  const update = (chart: DrilledChart, next: DashboardWidget) => setDrafts((cur) => ({ ...cur, [chart]: next }));

  useEffect(() => {
    // capture phase: the table inside handles keys of its own. In the settings pane Escape closes the pane.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (pane.current?.contains(e.target as Node)) setSelected(null); else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const slot = (chart: DrilledChart, height: number, className?: string) => {
    const draft = drafts[chart];
    if (!draft) return null;
    const p = previews[chart];
    return (
      <DraftSlot projectId={projectId} widget={draft} result={p.data} loading={p.isLoading} fetching={p.isFetching}
        error={p.error ? errorText(p.error) : null} labels={labels} height={height} selected={selected === chart}
        onSelect={() => setSelected(chart)} onRun={() => p.refetch()} className={className} />
    );
  };
  const editing = selected ? drafts[selected] : undefined;
  const run = (f: (p: Pick) => void) => () => { onClose(); f(pick); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div role="dialog" aria-label={`Drill into ${pickLabel(pick)}`} onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-[95vw] max-w-[88rem] h-[90vh] mx-4 bg-surface-panel border border-gray-700 rounded-lg shadow-2xl">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-800">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-gray-100 truncate">{pickLabel(pick)}</h2>
            <p className="text-[11px] text-gray-500 truncate">
              {pick.values.map((v) => `${v.dimension} = ${v.value}`).join(', ')}
              {result.current ? ` · ${rangeLabel(result.current)}` : ''}{result.previous ? ` vs ${rangeLabel(result.previous)}` : ''}
              {' · click a widget to configure it'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 overflow-auto p-5 flex flex-col gap-4">
            <div className="flex gap-3 min-w-0">
              {/* full width when every shared dimension is already filtered (no breakdown) */}
              {slot('summary', TOP_PX, drafts.breakdown ? 'w-1/3 shrink-0' : 'flex-1')}
              {slot('breakdown', TOP_PX, 'flex-1')}
            </div>
            {slot('table', TABLE_PX)}
          </div>
          {selected && editing && (
            <aside ref={pane} aria-label="Widget settings" className="flex flex-col w-80 shrink-0 border-l border-gray-800">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
                <span className="flex-1 text-xs font-medium text-gray-200 truncate">Configure {widgetInfo(editing.type).label.toLowerCase()}</span>
                <button onClick={() => setSelected(null)} aria-label="Close the settings" className="text-gray-500 hover:text-gray-200"><X className="w-3.5 h-3.5" /></button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto p-3">
                <WidgetSettings projectId={projectId} doc={doc} widget={editing} catalog={catalog} labels={labels}
                  onChange={(w) => update(selected, w)} onNotice={setNotice} />
              </div>
            </aside>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-gray-800">
          {notice && <span className="flex-1 min-w-0 text-[11px] text-amber-300 truncate">{notice}</span>}
          <button onClick={run(actions.onOpenInExplorer)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">
            <ExternalLink className="w-3.5 h-3.5" />Open in explorer
          </button>
          <button onClick={run(actions.onApplyFilter)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">
            <Filter className="w-3.5 h-3.5" />Apply as dashboard filter
          </button>
          {onAddToDashboard && (
            <AddDrilledMenu labels={labels}
              items={DRILLED_CHARTS.flatMap((c) => (drafts[c] ? [{ id: c, widget: drafts[c]! }] : []))}
              onAdd={(charts) => { onClose(); onAddToDashboard(charts.flatMap((c) => (drafts[c] ? [drafts[c]!] : []))); }} />
          )}
        </div>
      </div>
    </div>
  );
}
