// The metric explorer's query view, shown in ExploreModal (titled by its metric): one widget —
// any dashboard widget type — edited two ways that stay in sync: the query composer across the
// top (Composer.tsx: chips you type, incl. the period and comparison) and the dashboards'
// settings pane on the right (metrics, filters, its type's options: split by, bars by, rows by…).
// Refresh sits next to the composer; its rows, SQL, Debug and Compare (Pro) tabs underneath. It runs when
// nothing is stored for its settings; Refresh runs it anyway. The widget lives in the URL (lib/exploreWidget.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutDashboard, Loader2, RefreshCw } from 'lucide-react';
import type { DashboardDoc, DashboardWidget } from '../../../../lib/dashboardsApi';
import { alertError } from '../../../../lib/dialogs';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { useStickyTab } from '../../../../lib/useUrlTab';
import { relativeTime } from '../../lib/relativeTime';
import { AddToDashboardDialog } from '../dashboards/AddToDashboardDialog';
import { WidgetSettings } from '../dashboards/builder/WidgetSettings';
import { widgetTitle } from '../dashboards/dashboardModel';
import { errorText } from '../dashboards/useDashboards';
import { useMonitors } from '../monitors/useMonitors';
import { useExplorePreview } from '../dashboards/widgets/useWidgetPreview';
import { WidgetBody } from '../dashboards/widgets/WidgetBody';
import { WidgetMenuButton } from '../dashboards/widgets/WidgetMenu';
import { EXPLORE_HEIGHT, explorePeriod, mainQuery, withExplorePeriod } from '../lib/exploreWidget';
import { Composer } from './Composer';
import { writeWorkspaceSql } from '../lib/openInWorkspace';
import { UpgradeModal } from '../../components/UpgradeModal';
import { useProEntitled } from '../../RunHistory/usePerformance';
import { MetricQueryActivity } from '../MetricQueryActivity';

// the query view sits in a modal over the page header's activity: show its own runs here
const EXPLORE_RUN_KINDS = ['explore', 'compare'] as const;
import type { CompareState } from '../lib/compareView';
import { ComparePanel } from './ComparePanel';
import { ExploreResults, RESULT_TABS, resultsTabKey, type ResultTab } from './ExploreResults';
import { compareLabel, currentLabel, rangeLabel } from '../dashboards/periods';
import { useChartExports } from '../chartMenu/useChartExports';
import { useSaveAsSavedQuery } from '../chartMenu/useSaveAsSavedQuery';

const DEFAULT_COMPARE: CompareState = { mode: 'working', base: '' };
/** WidgetSettings reads period defaults from a dashboard; the explorer has none (standalone). */
const NO_DASHBOARD: DashboardDoc = { title: 'Explore', widgets: [] } as unknown as DashboardDoc;

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  widget: DashboardWidget;
  onChange: (widget: DashboardWidget) => void;
  onOpenDashboard: (slug: string) => void;
  /** the Compare tab's options (Pro; null = not set yet), in the URL next to the widget */
  compare: CompareState | null;
  onCompare: (next: CompareState) => void;
}

export function ExploreView({ projectId, catalog, labels, widget, onChange, onOpenDashboard, compare, onCompare }: Props) {
  const { entitled } = useProEntitled();
  const [upgrade, setUpgrade] = useState(false);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resultsTab, setResultsTab] = useStickyTab<ResultTab>(resultsTabKey(projectId), RESULT_TABS, 'table');
  const preview = useExplorePreview(projectId, widget);
  const { data: monitorData } = useMonitors(projectId);
  const monitors = useMemo(() => monitorData?.monitors ?? [], [monitorData]);
  const result = preview.data;
  const metrics = useMemo(() => widget.metrics ?? [], [widget.metrics]);
  const main = mainQuery(result);
  const exports = useChartExports(projectId);
  const saveQuery = useSaveAsSavedQuery(projectId);
  const chartRef = useRef<HTMLDivElement>(null);
  const shownPeriod = explorePeriod(widget);
  const periodText = [
    `${currentLabel(shownPeriod.current)}${result?.current ? ` (${rangeLabel(result.current)})` : ''}`,
    result?.previous ? `vs ${compareLabel(shownPeriod.compare).toLowerCase()} (${rangeLabel(result.previous)})` : null,
  ].filter(Boolean).join(' ');
  // a run answers at once (`running`) and finishes in the background (metric_queries_finished)
  const busy = preview.isFetching || preview.refreshing || result?.status === 'running';
  const title = widgetTitle(widget, labels);
  const runError = preview.refreshError ?? preview.error;

  // a link with compare options (Impact's "Compare numbers") opens on the Compare tab — nothing runs yet
  const arrivedComparing = useRef(!!compare);
  useEffect(() => {
    if (arrivedComparing.current) setResultsTab('compare');
  }, [setResultsTab]);

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
        <div className="flex flex-wrap items-start gap-2">
          <Composer projectId={projectId} catalog={catalog} labels={labels} widget={widget} onCommit={onChange} onRun={refresh} />
          <div className="flex items-center gap-2 min-h-[34px]">
            {result?.ran_at && !busy && <span className="text-[11px] text-gray-500">Last run {relativeTime(result.ran_at)}</span>}
            <MetricQueryActivity projectId={projectId} kinds={EXPLORE_RUN_KINDS} />
            <button onClick={() => refresh()} disabled={!metrics.length || busy} title="Run it on the warehouse again (⌘Enter)"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Refresh
            </button>
          </div>
        </div>
        {notice && <span className="text-[11px] text-amber-300">{notice}</span>}
        <div ref={chartRef} className="shrink-0">
          <section data-widget-id="explore" className="relative flex flex-col px-3 py-2 rounded border border-gray-800 bg-surface-panel" style={{ height: EXPLORE_HEIGHT + 40 }}>
            <div className="absolute top-1.5 right-1.5 z-10">
              <WidgetMenuButton items={[
                { label: 'Add to dashboard', icon: <LayoutDashboard className="w-3.5 h-3.5" />, onClick: () => setAdding(true), disabled: !metrics.length },
              saveQuery.item(result),
                ...exports.items({
                  result, element: () => chartRef.current, title, name: [metrics.join('_') || 'metric', widget.type],
                  subtitle: [periodText, result?.ran_at ? `data queried ${new Date(result.ran_at).toLocaleString()}` : null].filter(Boolean).join(' · '),
                }),
              ]} />
            </div>
            {runError && <p className="shrink-0 text-[11px] text-red-300">{errorText(runError)}</p>}
            <div className="flex-1 min-h-0">
              <WidgetBody projectId={projectId} widget={widget} result={result} labels={labels} height={EXPLORE_HEIGHT - 8}
                loading={preview.isLoading} refreshing={busy} monitors={monitors} filtered={!!widget.filters?.length} updating={false}
                onRun={() => refresh()} onPick={null} onPickMenu={null} drilled={null}
                emptyHint="Add a metric in Configure." />
            </div>
            {(result?.notes ?? []).map((n) => <p key={n} className="shrink-0 text-[10px] text-gray-500 truncate" title={n}>{n}</p>)}
          </section>
        </div>
        <div id="explore-results">
          <ExploreResults projectId={projectId} result={result} loading={preview.isLoading} onOpenInWorkspace={openInWorkspace} tab={resultsTab} onTab={setResultsTab}
            onSetPeriod={(range) => onChange(withExplorePeriod(widget, { current: range }))}
            compare={entitled ? (
              <ComparePanel projectId={projectId} catalog={catalog} labels={labels} query={main?.body ?? null}
                grain={result?.grain ?? 'day'} state={compare ?? DEFAULT_COMPARE} onChange={onCompare} />
            ) : (
              <div className="flex flex-col items-start gap-2 p-4 text-xs text-gray-400">
                <p>Compare is a wickd Pro feature: run this query two ways — uncommitted changes vs HEAD, this branch vs its base, two targets or two metrics — and see what moved.</p>
                <button onClick={() => setUpgrade(true)} className="text-brand-300 hover:text-brand-200">Unlock Pro</button>
              </div>
            )} />
        </div>
      </div>
      <aside aria-label="Widget settings" className="flex flex-col w-80 shrink-0 border-l border-gray-800 bg-surface-panel min-h-0">
        <div className="px-3 py-2 border-b border-gray-800 text-xs font-medium text-gray-200">Configure</div>
        <div className="flex-1 min-h-0 overflow-auto p-3">
          <WidgetSettings projectId={projectId} doc={NO_DASHBOARD} widget={widget} catalog={catalog} labels={labels}
            onChange={onChange} onNotice={setNotice} standalone />
        </div>
      </aside>
      {exports.modal}
      {saveQuery.modal}
      {upgrade && <UpgradeModal feature="Metric compare" onClose={() => setUpgrade(false)} />}
      {adding && (
        <AddToDashboardDialog projectId={projectId} widget={widget} catalog={catalog} title={title}
          onClose={() => setAdding(false)} onAdded={(slug) => { setAdding(false); onOpenDashboard(slug); }} />
      )}
    </div>
  );
}
