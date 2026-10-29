// Explorer → "Add to dashboard…": pick a dashboard (or name a new one) and the widget type;
// the query becomes a widget (metrics, group-bys as the type's options, filters, dates) at
// the end of the dashboard.
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { dashboardsApi, type WidgetType } from '../../../../lib/dashboardsApi';
import type { MetricQueryBody, SemanticCatalogDto } from '../../../../lib/semanticApi';
import { widgetFromQuery, widgetInfo, WIDGET_TYPES } from './dashboardModel';
import { errorText, useDashboardList } from './useDashboards';

interface Props {
  projectId: number;
  body: MetricQueryBody;
  catalog: SemanticCatalogDto;
  /** suggested widget title (the metric labels) */
  title: string;
  onAdded: (slug: string) => void;
  onClose: () => void;
}

const NEW = '__new__';
const FIELD = 'w-full px-2 py-1.5 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

export function AddToDashboardDialog({ projectId, body, catalog, title, onAdded, onClose }: Props) {
  const list = useDashboardList(projectId);
  const valid = useMemo(() => (list.data?.dashboards ?? []).filter((d) => !d.error), [list.data]);
  const suggested = useMemo(() => widgetFromQuery(body, catalog, []), [body, catalog]);
  const [target, setTarget] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [type, setType] = useState<WidgetType>(suggested.type);
  const [widgetTitle, setWidgetTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!target && list.data) setTarget(valid[0]?.slug ?? NEW); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const build = (taken: string[]) => {
    const base = widgetFromQuery(body, catalog, taken);
    const info = widgetInfo(type);
    const typed = type === base.type ? base : { ...base, type, width: info.width, height: info.height, metrics: (base.metrics ?? []).slice(0, info.maxMetrics) };
    return widgetTitle.trim() ? { ...typed, title: widgetTitle.trim() } : typed;
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      if (target === NEW) {
        const created = await dashboardsApi.create(projectId, newTitle.trim(), [build([])]);
        onAdded(created.slug);
        return;
      }
      const detail = await dashboardsApi.get(projectId, target);
      if (!detail.dashboard) throw new Error(detail.error ?? 'That dashboard file is invalid.');
      const widget = build(detail.dashboard.widgets.map((w) => w.id));
      await dashboardsApi.save(projectId, target, { ...detail.dashboard, widgets: [...detail.dashboard.widgets, widget] }, detail.modified_at);
      onAdded(target);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const ready = target === NEW ? newTitle.trim().length > 0 : !!target;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div role="dialog" aria-label="Add to dashboard" onClick={(e) => e.stopPropagation()}
        className="flex flex-col gap-4 w-full max-w-md mx-4 p-5 bg-surface-panel border border-gray-700 rounded-lg shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-100">Add to dashboard</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-gray-500">Dashboard</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={FIELD}>
            {valid.map((d) => <option key={d.slug} value={d.slug}>{d.title}</option>)}
            <option value={NEW}>New dashboard…</option>
          </select>
        </label>
        {target === NEW && <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Dashboard title" className={FIELD} />}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-gray-500">Widget</span>
          <select value={type} onChange={(e) => setType(e.target.value as WidgetType)} className={FIELD}>
            {WIDGET_TYPES.filter((t) => t.maxMetrics > 0).map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-gray-500">Title</span>
          <input value={widgetTitle} onChange={(e) => setWidgetTitle(e.target.value)} placeholder={title} className={FIELD} />
        </label>
        <p className="text-[11px] text-gray-500">The widget follows the dashboard's period unless your query has its own dates. Change anything later in the widget's settings.</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">Cancel</button>
          <button onClick={add} disabled={!ready || busy} className="px-4 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
            Add widget
          </button>
        </div>
      </div>
    </div>
  );
}
