// A widget's settings: the shared ones (title, type, metrics, filters, period override) and then
// its type's own (TypeOptions). The builder's Configure tab and Drill into… both use it.
import { X } from 'lucide-react';
import type { ComparePeriod, CurrentPeriod, DashboardDoc, DashboardWidget, WidgetType } from '../../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../../lib/semanticApi';
import { FilterEditor } from '../../FilterEditor';
import { groupByOptions } from '../../lib/metricQuery';
import {
  addMetric, changeType, COMPARE_PRESETS, compareLabel, CURRENT_PRESETS, currentLabel, removeMetric, resolveCompare, resolveCurrent,
  sharedDimensions, WIDGET_TYPES, widgetInfo,
} from '../dashboardModel';
import { useValueSuggest } from './PeriodBar';
import { PeriodPicker } from './PeriodPicker';
import { FIELD, Row, TypeOptions } from './TypeOptions';

export interface WidgetSettingsProps {
  projectId: number;
  doc: DashboardDoc;
  widget: DashboardWidget;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  onChange: (w: DashboardWidget) => void;
  onNotice: (message: string) => void;
}

export function WidgetSettings({ projectId, doc, widget, catalog, labels, onChange, onNotice }: WidgetSettingsProps) {
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
