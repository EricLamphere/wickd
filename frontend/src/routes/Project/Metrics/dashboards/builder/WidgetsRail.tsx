// Right rail. "Widgets": the widget types; drag one onto the canvas (or click to add it at the
// end). "Configure": the selected widget's shared settings (title, type, size, metrics,
// filters, period override) and then its type's own settings.
import { useEffect, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { BarChart3, Gauge, LineChart, ListOrdered, Table2, Type, X } from 'lucide-react';
import type { ComparePeriod, CurrentPeriod, DashboardDoc, DashboardWidget, WidgetType } from '../../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../../lib/semanticApi';
import { FilterEditor } from '../../FilterEditor';
import { groupByOptions } from '../../lib/metricQuery';
import {
  addMetric, changeType, clampCanvasWidth, COMPARE_PRESETS, compareLabel, CURRENT_PRESETS, currentLabel, removeMetric, resolveCompare, resolveCurrent,
  sharedDimensions, WIDGET_TYPES, widgetInfo,
} from '../dashboardModel';
import { useValueSuggest } from './PeriodBar';
import { PeriodPicker } from './PeriodPicker';
import { FIELD, Row, TypeOptions } from './TypeOptions';
import { FloatingRail, type Rail } from './RailResize';

export const WIDGET_ICONS: Record<WidgetType, typeof Gauge> = {
  summary: Gauge, timeseries: LineChart, bar: BarChart3, leaderboard: ListOrdered, table: Table2, text: Type,
};

export type RailTab = 'widgets' | 'configure';

function PaletteItem({ type, onAdd }: { type: WidgetType; onAdd: () => void }) {
  const info = widgetInfo(type);
  const Icon = WIDGET_ICONS[type];
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `type:${type}`, data: { kind: 'type', type } });
  return (
    <button ref={setNodeRef} {...attributes} {...listeners} type="button" onClick={onAdd}
      className={`flex items-start gap-2.5 w-full p-2 text-left rounded border border-gray-800 bg-surface-app hover:border-gray-600 cursor-grab ${isDragging ? 'opacity-40' : ''}`}>
      <span className="flex items-center justify-center w-8 h-8 shrink-0 rounded bg-brand-950/50 text-brand-300"><Icon className="w-4 h-4" /></span>
      <span className="flex flex-col min-w-0">
        <span className="text-xs font-medium text-gray-100">{info.label}</span>
        <span className="text-[11px] leading-snug text-gray-500">{info.description}</span>
      </span>
    </button>
  );
}

interface ConfigProps {
  projectId: number;
  doc: DashboardDoc;
  widget: DashboardWidget;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  onChange: (w: DashboardWidget) => void;
  onNotice: (message: string) => void;
}

function Configure({ projectId, doc, widget, catalog, labels, onChange, onNotice }: ConfigProps) {
  const metrics = widget.metrics ?? [];
  const info = widgetInfo(widget.type);
  const options = groupByOptions(catalog, metrics);
  const suggest = useValueSuggest(projectId, catalog, metrics);
  const dims = metrics.length ? sharedDimensions(catalog, metrics) : [];
  const dashCurrent: CurrentPeriod = doc.period?.current ?? 'last_30_days';
  const dashCompare: ComparePeriod = doc.period?.compare ?? 'previous_period';
  const current = widget.period?.current ?? dashCurrent;
  const resolved = resolveCurrent(current);
  const compare = widget.period?.compare ?? dashCompare;
  const setPeriod = (patch: { current?: CurrentPeriod | null; compare?: ComparePeriod | null }) => {
    const next = { ...(widget.period ?? {}), ...patch };
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null && v !== undefined));
    onChange({ ...widget, period: Object.keys(clean).length ? clean : undefined });
  };
  const add = (metric: string) => {
    const result = addMetric(widget, metric, catalog);
    if (result.widget) onChange(result.widget); else onNotice(result.error);
  };

  return (
    <div className="flex flex-col gap-3">
      <Row label="Title">
        <input value={widget.title ?? ''} placeholder={widget.type === 'text' ? 'No title' : metrics.map((m) => labels.get(m) ?? m).join(', ') || info.label}
          onChange={(e) => onChange({ ...widget, title: e.target.value || undefined })} className={FIELD} />
      </Row>
      <Row label="Type">
          <select value={widget.type} className={FIELD} onChange={(e) => onChange(changeType(widget, e.target.value as WidgetType, catalog))}>
            {WIDGET_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
      </Row>

      {info.maxMetrics > 0 && (
        <>
          <Row label={`Metrics${info.maxMetrics > 1 ? ` (up to ${info.maxMetrics})` : ''}`}>
            <div className="flex flex-wrap gap-1">
              {metrics.map((m) => (
                <span key={m} className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border border-gray-700 bg-gray-800/60 text-gray-200">
                  {labels.get(m) ?? m}
                  <button onClick={() => onChange(removeMetric(widget, m))} aria-label={`Remove ${m}`} className="text-gray-500 hover:text-gray-200">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            {metrics.length < info.maxMetrics && (
              <select value="" onChange={(e) => { if (e.target.value) add(e.target.value); }} className={FIELD}>
                <option value="">Add a metric…</option>
                {catalog.metrics.filter((m) => !metrics.includes(m.name)).map((m) => (
                  <option key={m.name} value={m.name}>{labels.get(m.name) ?? m.name}</option>
                ))}
              </select>
            )}
          </Row>
          <Row label="Filters" hint="Added to the dashboard's filters for this widget only.">
            <FilterEditor filters={widget.filters ?? []} options={options} grain="day" suggest={suggest}
              onChange={(filters) => onChange({ ...widget, filters: filters.length ? filters : undefined })} />
          </Row>
          <Row label="Period" hint={widget.period?.current ? undefined : "Follows the dashboard's period."}>
            <PeriodPicker ariaLabel="Widget period" months={1}
              label={widget.period?.current ? currentLabel(current) : `Dashboard's: ${currentLabel(dashCurrent)}`}
              resolved={resolved} value={current} presets={CURRENT_PRESETS} onChange={(v) => setPeriod({ current: v as CurrentPeriod })}
              inherit={{ label: `Use the dashboard's (${currentLabel(dashCurrent)})`, active: !widget.period?.current, onSelect: () => setPeriod({ current: null }) }} />
          </Row>
          <Row label="Compare to" hint={widget.period?.compare ? undefined : "Follows the dashboard's comparison."}>
            <PeriodPicker ariaLabel="Widget comparison" muted months={1}
              label={widget.period?.compare ? compareLabel(compare) : `Dashboard's: ${compareLabel(dashCompare)}`}
              resolved={resolveCompare(compare, resolved)} value={compare} presets={COMPARE_PRESETS}
              onChange={(v) => setPeriod({ compare: v as ComparePeriod })}
              inherit={{ label: `Use the dashboard's (${compareLabel(dashCompare)})`, active: !widget.period?.compare, onSelect: () => setPeriod({ compare: null }) }} />
          </Row>
        </>
      )}
      <div className="flex flex-col gap-3 pt-3 border-t border-gray-800">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{info.label} settings</h3>
        <TypeOptions widget={widget} dimensions={dims} onChange={onChange} />
      </div>
    </div>
  );
}

interface Props extends Omit<ConfigProps, 'widget'> {
  tab: RailTab;
  onTab: (tab: RailTab) => void;
  widget: DashboardWidget | null;
  onAddType: (type: WidgetType) => void;
  rail: Rail;
  canvasWidth: number;
  onCanvasWidth: (px: number) => void;
}

/** The dashboard's fixed width: edited as text, applied on Enter or blur (clamped). */
function CanvasWidth({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) onChange(clampCanvasWidth(n)); else setDraft(String(value));
  };
  return (
    <Row label="Dashboard width" hint="Fixed, so widgets keep their size whatever the window or these panes do. You can also drag the dashboard's right edge.">
      <div className="flex items-center gap-1.5">
        <input value={draft} inputMode="numeric" onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} className={`${FIELD.replace('w-full ', '')} w-24`} aria-label="Dashboard width" />
        <span className="text-[11px] text-gray-500">px</span>
      </div>
    </Row>
  );
}

export function WidgetsRail({ tab, onTab, widget, onAddType, rail, canvasWidth, onCanvasWidth, ...config }: Props) {
  const shown = widget ? tab : 'widgets';
  return (
    <FloatingRail side="right" rail={rail}>
      <div className="flex items-center gap-1 px-3 border-b border-gray-800" role="tablist">
        {(['widgets', 'configure'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={shown === t} disabled={t === 'configure' && !widget} onClick={() => onTab(t)}
            className={`px-2 py-2 text-xs border-b-2 -mb-px disabled:opacity-40 ${shown === t ? 'border-brand-500 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {t === 'widgets' ? 'Widgets' : 'Configure'}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {shown === 'widgets' || !widget ? (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] text-gray-500">Drag a widget onto the dashboard, or click to add it at the end.</p>
            {WIDGET_TYPES.map((t) => <PaletteItem key={t.type} type={t.type} onAdd={() => onAddType(t.type)} />)}
            <div className="pt-3 mt-1 border-t border-gray-800"><CanvasWidth value={canvasWidth} onChange={onCanvasWidth} /></div>
          </div>
        ) : (
          <Configure {...config} widget={widget} />
        )}
      </div>
    </FloatingRail>
  );
}
