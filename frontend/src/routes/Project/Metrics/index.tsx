// Metrics page (/projects/:id/metrics): Explore tab — with nothing asked for, the metric index
// (explore/MetricIndex); `?metric=<name>`, a metric's page (explore/MetricPage, plan 13);
// `?view=query&w=<widget>`, the query view (explore/ExploreView): one widget of any dashboard
// type, configured in the dashboards' settings pane. Older links' query params become that
// widget on arrival (lib/exploreWidget.ts). Back/forward steps index → page → query.
// Dashboards tab (?tab=dashboards): metric queries pinned as tiles, YAML files in the project (dashboards/).
// Monitors tab (?tab=monitors, Pro): metrics watched for anomalies (monitors/).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import type { DashboardWidget } from '../../../lib/dashboardsApi';
import { alertDialog } from '../../../lib/dialogs';
import { semanticErrorBody, type CatalogSavedQuery, type SemanticCatalogDto } from '../../../lib/semanticApi';
import { useSemanticStatus } from '../components/semantic/useSemantic';
import NavRail from '../components/NavRail';
import { useOpenInFiles } from '../lib/openInFiles';
import { useUrlTab } from '../../../lib/useUrlTab';
import type { MonitorDraft } from './monitors/CreateMonitorDialog';
import { MonitorsTab } from './monitors/MonitorsTab';
import { addMetric, removeMetric, widgetFromQuery } from './dashboards/dashboardModel';
import { DashboardsTab } from './dashboards/DashboardsTab';
import { ProLabel } from '../../../components/ProLabel';
import { DraftFromModel } from './DraftFromModel';
import { MetricsSidebar } from './MetricsSidebar';
import { MetricsUnavailable } from './MetricsUnavailable';
import {
  clearExplore, emptyExploreWidget, isExploreView, readExploreWidget, widgetFromLegacy, writeExploreWidget,
} from './lib/exploreWidget';
import { readCompare, writeCompare, type CompareState } from './lib/compareView';
import { ExploreView } from './explore/ExploreView';
import { MetricIndex } from './explore/MetricIndex';
import { MetricPage } from './explore/MetricPage';
import { useMetricPeriod } from './explore/useMetricPages';
import { useActiveTarget, useSemanticCatalog } from './useMetricExplorer';

function errorText(err: unknown): string | null {
  if (!err) return null;
  return semanticErrorBody(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

function labelsFor(catalog: SemanticCatalogDto | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  for (const m of catalog?.metrics ?? []) if (m.label) labels.set(m.name, m.label);
  for (const q of catalog?.saved_queries ?? []) labels.set(`saved:${q.name}`, q.label || q.name);
  return labels;
}

export default function MetricsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  return (
    <div className="flex h-full overflow-hidden">
      <NavRail projectId={id} current="metrics" />
      <div className="flex-1 min-w-0 overflow-hidden"><MetricsContent id={id} /></div>
    </div>
  );
}

function MetricsContent({ id }: { id: number }) {
  const { data: status, isLoading, error } = useSemanticStatus(id);
  const ready = !!status?.available && status.can_query;
  const catalogQuery = useSemanticCatalog(id, ready);

  if (isLoading) return <p className="p-6 text-xs text-gray-500">Loading…</p>;
  if (error || !status) return <p className="p-6 text-xs text-red-400">Couldn't load the semantic layer status: {errorText(error)}</p>;
  if (status.counts.metrics === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 h-full p-8 text-center">
        <h2 className="text-sm font-medium text-gray-200">No metrics yet</h2>
        <p className="max-w-md text-xs text-gray-500">Define semantic models and metrics in YAML and they show up here after dbt parses.</p>
        <DraftFromModel projectId={id} />
      </div>
    );
  }
  if (!ready) return <MetricsUnavailable projectId={id} status={status} />;
  if (catalogQuery.isLoading) return <p className="p-6 text-xs text-gray-500">Loading metrics…</p>;
  if (!catalogQuery.data) return <p className="p-6 text-xs text-red-400">Couldn't load the metrics: {errorText(catalogQuery.error)}</p>;
  return <MetricsTabs projectId={id} catalog={catalogQuery.data} />;
}

const TABS = ['explore', 'dashboards', 'monitors'] as const;
const TAB_LABELS = { explore: 'Metrics', dashboards: 'Dashboards' } as const;

function MetricsTabs({ projectId, catalog }: { projectId: number; catalog: SemanticCatalogDto }) {
  const [tab, setTab] = useUrlTab('tab', TABS, 'explore');
  const [, setParams] = useSearchParams();
  const [draft, setDraft] = useState<MonitorDraft | null>(null);
  const labels = useMemo(() => labelsFor(catalog), [catalog]);
  const { data: target } = useActiveTarget(projectId);
  const monitor = (next: MonitorDraft) => { setDraft(next); setTab('monitors'); };
  // A dashboard widget in the explorer (Open in explorer), as it showed there
  const openExplorer = useCallback((widget: DashboardWidget) => {
    setParams((prev) => {
      const next = writeExploreWidget(prev, widget);
      next.set('tab', 'explore');
      return next;
    });
  }, [setParams]);
  const openMetricPage = useCallback((metric: string) => {
    setParams((prev) => {
      const next = clearExplore(prev);
      next.set('tab', 'explore');
      next.set('metric', metric);
      next.delete('dashboard');
      return next;
    });
  }, [setParams]);
  const openDashboard = useCallback((slug: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'dashboards');
      next.set('dashboard', slug);
      return next;
    });
  }, [setParams]);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-3 border-b border-gray-800 bg-surface-panel shrink-0" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`flex items-center px-3 py-2 text-xs border-b-2 -mb-px ${tab === t ? 'border-brand-500 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {t === 'monitors' ? <ProLabel>Monitors</ProLabel> : TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'explore' && (
          <Explorer projectId={projectId} catalog={catalog} onMonitor={monitor} onOpenDashboard={openDashboard} onOpenMonitors={() => setTab('monitors')} />
        )}
        {tab === 'dashboards' && (
          <DashboardsTab projectId={projectId} catalog={catalog} labels={labels} target={target?.target ?? null} onOpenExplorer={openExplorer}
            onOpenMetric={openMetricPage} />
        )}
        {tab === 'monitors' && <MonitorsTab projectId={projectId} catalog={catalog} draft={draft} onDraftHandled={() => setDraft(null)} />}
      </div>
    </div>
  );
}

function Explorer({ projectId, catalog, onMonitor, onOpenDashboard, onOpenMonitors }: {
  projectId: number; catalog: SemanticCatalogDto; onMonitor: (draft: MonitorDraft) => void; onOpenDashboard: (slug: string) => void;
  onOpenMonitors: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const [period, setPeriod] = useMetricPeriod(projectId);
  const labels = useMemo(() => labelsFor(catalog), [catalog]);
  const { data: graph } = useQuery({ queryKey: ['graph', projectId], queryFn: () => api.models.graph(projectId) });
  const { open } = useOpenInFiles(projectId);
  // the index (nothing asked for) → a metric's page (?metric=) → the query view (?view=query&w=, or an older link's query)
  const pageMetric = params.get('metric');
  const mode = pageMetric ? 'page' : isExploreView(params) ? 'explore' : 'index';
  const widget = useMemo(() => readExploreWidget(params), [params]);

  // An older explorer link (Docs' Explore, ⌘K, Wicky, saved queries): becomes the widget, in place
  useEffect(() => {
    if (mode === 'explore' && !widget) setParams((prev) => writeExploreWidget(prev, widgetFromLegacy(prev, catalog)), { replace: true });
  }, [mode, widget, catalog, setParams]);

  const openMetric = useCallback((name: string) => {
    setParams((prev) => {
      const next = clearExplore(prev);
      next.set('metric', name);
      return next;
    });
  }, [setParams]);
  const showIndex = useCallback(() => {
    setParams((prev) => {
      const next = clearExplore(prev);
      next.delete('metric');
      return next;
    });
  }, [setParams]);
  // a new query (from the index, a metric page, Impact): compare mode only when asked for
  const explore = useCallback((next: DashboardWidget, cmp: CompareState | null = null) => {
    setParams((prev) => writeCompare(writeExploreWidget(prev, next), cmp));
  }, [setParams]);
  const compare = useMemo(() => readCompare(params), [params]);
  const setCompare = useCallback((next: CompareState | null) => setParams((prev) => writeCompare(prev, next)), [setParams]);
  // settings edits replace the history entry (one per change would bury Back under keystrokes)
  const editWidget = useCallback((next: DashboardWidget) => setParams((prev) => writeExploreWidget(prev, next), { replace: true }), [setParams]);
  const exploreSaved = (q: CatalogSavedQuery) => explore({ ...widgetFromQuery({ saved_query: q.name }, catalog, []), id: 'explore' });

  const metricUid = useMemo(() => {
    const uids = new Map<string, string>();
    for (const n of graph?.nodes ?? []) if (n.resource_type === 'metric' && n.original_file_path) uids.set(n.name, n.unique_id);
    return uids;
  }, [graph]);

  // in the query view a metric click adds it to (or takes it off) the widget; elsewhere it opens its page
  const clickMetric = async (m: string) => {
    if (mode !== 'explore' || !widget) { openMetric(m); return; }
    if (widget.metrics?.includes(m)) { editWidget(removeMetric(widget, m)); return; }
    const added = addMetric(widget, m, catalog);
    if (added.widget) editWidget(added.widget); else await alertDialog(added.error, { title: "Can't add it here" });
  };

  return (
    <div className="flex h-full min-h-0">
      <MetricsSidebar
        catalog={catalog}
        selected={mode === 'page' && pageMetric ? [pageMetric] : mode === 'explore' ? widget?.metrics ?? [] : []}
        savedQuery={null}
        onShowIndex={showIndex}
        indexActive={mode === 'index'}
        onToggleMetric={(m) => { void clickMetric(m); }}
        onRunSaved={exploreSaved}
        onEditSaved={exploreSaved}
        onOpenYaml={(m) => { const uid = metricUid.get(m); if (uid) open(uid); }}
      />
      {mode === 'index' && (
        <main className="flex-1 min-w-0 min-h-0 overflow-auto">
          <MetricIndex projectId={projectId} catalog={catalog} period={period} onPeriod={setPeriod} onOpen={openMetric}
            onExplore={() => explore({ ...emptyExploreWidget(), period })} />
        </main>
      )}
      {mode === 'page' && pageMetric && (
        <main className="flex-1 min-w-0 min-h-0 overflow-auto">
          {catalog.metrics.find((m) => m.name === pageMetric) ? (
            <MetricPage key={pageMetric} projectId={projectId} catalog={catalog} metric={catalog.metrics.find((m) => m.name === pageMetric)!}
              period={period} onPeriod={setPeriod} onIndex={showIndex} onOpenMetric={openMetric} onExplore={explore}
              onRunSaved={(name) => { const q = catalog.saved_queries.find((x) => x.name === name); if (q) exploreSaved(q); }}
              onOpenDashboard={onOpenDashboard} onMonitor={onMonitor} onOpenMonitors={onOpenMonitors} />
          ) : (
            <div className="flex flex-col items-start gap-2 p-5 text-xs text-gray-400">
              <span>There's no metric called <code className="font-mono">{pageMetric}</code> (renamed or removed?).</span>
              <button onClick={showIndex} className="text-brand-300 hover:text-brand-200">All metrics</button>
            </div>
          )}
        </main>
      )}
      {mode === 'explore' && widget && (
        <main className="flex-1 min-w-0 min-h-0">
          <ExploreView projectId={projectId} catalog={catalog} labels={labels} widget={widget} onChange={editWidget}
            onIndex={showIndex} onOpenMetric={openMetric} onOpenDashboard={onOpenDashboard} onMonitor={onMonitor}
            compare={compare} onCompare={setCompare} />
        </main>
      )}
    </div>
  );
}
