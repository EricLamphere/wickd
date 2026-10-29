// The metric explorer's query view: one widget — any dashboard widget type — configured in the
// dashboards' settings pane on the right (metrics, filters, its type's options: split by, bars
// by, rows by…), its period in the top bar with the dashboards' pickers, and its rows and SQL
// underneath. It runs when nothing is stored for its settings; Refresh runs it anyway. The
// widget lives in the URL (lib/exploreWidget.ts).
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bookmark, FileBarChart, LayoutDashboard, Loader2, Radar, RefreshCw } from 'lucide-react';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import type { DashboardDoc, DashboardWidget } from '../../../../lib/dashboardsApi';
import { alertDialog, alertError, promptDialog } from '../../../../lib/dialogs';
import { semanticApi, type SemanticCatalogDto } from '../../../../lib/semanticApi';
import { relativeTime } from '../../lib/relativeTime';
import { AddToDashboardDialog } from '../dashboards/AddToDashboardDialog';
import { WidgetSettings } from '../dashboards/builder/WidgetSettings';
import { opt, widgetTitle } from '../dashboards/dashboardModel';
import { errorText } from '../dashboards/useDashboards';
import { useMonitors } from '../monitors/useMonitors';
import { useExplorePreview } from '../dashboards/widgets/useWidgetPreview';
import { WidgetBody } from '../dashboards/widgets/WidgetBody';
import type { MonitorDraft } from '../monitors/CreateMonitorDialog';
import { EXPLORE_HEIGHT, explorePeriod, mainQuery, savedQueryBody, withExplorePeriod } from '../lib/exploreWidget';
import { writeWorkspaceSql } from '../lib/openInWorkspace';
import { ExploreResults } from './ExploreResults';
import { PeriodControl } from './PeriodControl';

const BTN = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500 disabled:opacity-40';
const MONITOR_GRAINS = ['day', 'week', 'month'] as const;
/** WidgetSettings reads period defaults from a dashboard; the explorer has none (standalone). */
const NO_DASHBOARD: DashboardDoc = { title: 'Explore', widgets: [] } as unknown as DashboardDoc;

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  widget: DashboardWidget;
  onChange: (widget: DashboardWidget) => void;
  onIndex: () => void;
  onOpenMetric: (name: string) => void;
  onOpenDashboard: (slug: string) => void;
  onMonitor: (draft: MonitorDraft) => void;
}

export function ExploreView({ projectId, catalog, labels, widget, onChange, onIndex, onOpenMetric, onOpenDashboard, onMonitor }: Props) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const preview = useExplorePreview(projectId, widget);
  const { data: monitorData } = useMonitors(projectId);
  const monitors = useMemo(() => monitorData?.monitors ?? [], [monitorData]);
  const result = preview.data;
  const metrics = useMemo(() => widget.metrics ?? [], [widget.metrics]);
  const main = mainQuery(result);
  const busy = preview.isFetching || preview.refreshing;
  const title = widgetTitle(widget, labels);
  const runError = preview.refreshError ?? preview.error;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // ⌘Enter refreshes, like Run did in the old query bar
  const refresh = preview.refresh;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && metrics.length) { e.preventDefault(); refresh(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh, metrics.length]);

  const monitorDraft = useMemo((): MonitorDraft | null => {
    if (metrics.length !== 1) return null;
    const grain = opt<string>(widget, 'grain', result?.grain ?? 'day');
    const dimension = opt<string | null>(widget, 'split_by', null) ?? opt<string | null>(widget, 'dimension', null);
    return { metric: metrics[0], grain: (MONITOR_GRAINS as readonly string[]).includes(grain) ? grain as MonitorDraft['grain'] : 'day', dimension };
  }, [metrics, widget, result?.grain]);

  const saveQuery = async () => {
    if (!main) return;
    const name = await promptDialog('Name for the saved query (lowercase, digits, underscores):', metrics.join('_by_').slice(0, 60),
      { title: 'Save as saved query', confirmLabel: 'Save' });
    if (!name) return;
    try {
      const { path } = await semanticApi.saveQuery(projectId, { ...savedQueryBody(main.body), name: name.trim() });
      await alertDialog(`Added \`${name.trim()}\` to ${path}. It shows up under Saved queries once dbt re-parses.`, { title: 'Saved query added' });
    } catch (err) {
      await alertDialog(errorText(err) ?? 'Saving failed', { title: "Couldn't save the query" });
    }
  };

  const openInWorkspace = async (sql: string) => {
    try {
      await writeWorkspaceSql(projectId, metrics.join('_') || 'metric_query', sql);
      navigate(`/projects/${projectId}/workspace`);
    } catch (err) {
      await alertError(err);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex flex-col flex-1 min-w-0 min-h-0 gap-3 p-4 overflow-auto">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onIndex} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-200">
            <ArrowLeft className="w-3.5 h-3.5" />All metrics
          </button>
          {metrics.map((m) => (
            <button key={m} onClick={() => onOpenMetric(m)} title={`${labels.get(m) ?? m}: definition, lineage, usage and health`}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-300 hover:border-brand-600 hover:text-brand-300">
              <FileBarChart className="w-3 h-3" />{labels.get(m) ?? m}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 min-w-[12rem] text-sm font-semibold text-gray-100 truncate" title={title}>{title}</h2>
          {result?.ran_at && !busy && <span className="text-[11px] text-gray-500">Last run {relativeTime(result.ran_at)}</span>}
          <PeriodControl period={explorePeriod(widget)} onChange={(p) => onChange(withExplorePeriod(widget, p))} />
          <button onClick={() => refresh()} disabled={!metrics.length || busy} title="Run it on the warehouse again (⌘Enter)"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Refresh
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setAdding(true)} disabled={!metrics.length} className={BTN}><LayoutDashboard className="w-3.5 h-3.5" />Add to dashboard</button>
          <button onClick={saveQuery} disabled={!main} className={BTN}><Bookmark className="w-3.5 h-3.5" />Save as saved query</button>
          {monitorDraft && (
            <ProFeatureButton title="Watch it for anomalies (Pro)" onClick={() => onMonitor(monitorDraft)}>
              <Radar className="w-3.5 h-3.5" />Monitor
            </ProFeatureButton>
          )}
          {notice && <span className="text-[11px] text-amber-300">{notice}</span>}
        </div>
        <section className="flex flex-col shrink-0 px-3 py-2 rounded border border-gray-800 bg-surface-panel" style={{ height: EXPLORE_HEIGHT + 40 }}>
          {runError && <p className="shrink-0 text-[11px] text-red-300">{errorText(runError)}</p>}
          <div className="flex-1 min-h-0">
            <WidgetBody projectId={projectId} widget={widget} result={result} labels={labels} height={EXPLORE_HEIGHT - 8}
              loading={preview.isLoading} refreshing={busy} monitors={monitors} filtered={!!widget.filters?.length} updating={false}
              onRun={() => refresh()} onPick={null} onPickMenu={null} drilled={null}
              emptyHint="Pick a metric on the left, or add one in Configure." />
          </div>
          {(result?.notes ?? []).map((n) => <p key={n} className="shrink-0 text-[10px] text-gray-500 truncate" title={n}>{n}</p>)}
        </section>
        <ExploreResults projectId={projectId} result={result} onOpenInWorkspace={openInWorkspace} />
      </div>
      <aside aria-label="Widget settings" className="flex flex-col w-80 shrink-0 border-l border-gray-800 bg-surface-panel min-h-0">
        <div className="px-3 py-2 border-b border-gray-800 text-xs font-medium text-gray-200">Configure</div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          <WidgetSettings projectId={projectId} doc={NO_DASHBOARD} widget={widget} catalog={catalog} labels={labels}
            onChange={onChange} onNotice={setNotice} standalone />
        </div>
      </aside>
      {adding && (
        <AddToDashboardDialog projectId={projectId} widget={widget} catalog={catalog} title={title}
          onClose={() => setAdding(false)} onAdded={(slug) => { setAdding(false); onOpenDashboard(slug); }} />
      )}
    </div>
  );
}
