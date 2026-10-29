// A metric's page (plan 13): what it is, its chart for a chosen period (stored result first,
// Run for fresh), where it comes from, what you can slice it by, where it's used and its
// health — with the actions that start from a metric (explore, dashboard, monitor, saved
// query, Wicky, YAML).
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bookmark, Bot, ExternalLink, FileCode2, LayoutDashboard, Loader2, Play, Radar } from 'lucide-react';
import { alertDialog, promptDialog } from '../../../../lib/dialogs';
import { semanticApi, type CatalogMetric, type SemanticCatalogDto } from '../../../../lib/semanticApi';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { SemanticDetails } from '../../components/SidePane/SemanticDetails';
import { useOpenInFiles } from '../../lib/openInFiles';
import { relativeTime } from '../../lib/relativeTime';
import { openWicky } from '../../lib/wickyEvents';
import { AddToDashboardDialog } from '../dashboards/AddToDashboardDialog';
import { TimeseriesWidget } from '../dashboards/widgets/TimeseriesWidget';
import { errorText } from '../dashboards/useDashboards';
import type { MonitorDraft } from '../monitors/CreateMonitorDialog';
import { TYPE_CLS } from '../MetricsSidebar';
import { chartResult, metricIssues, metricLineage, metricUsage, type MetricPeriod } from '../lib/metricPage';
import { emptyExploreWidget } from '../lib/exploreWidget';
import { METRIC_TIME } from '../lib/metricQuery';
import type { DashboardWidget } from '../../../../lib/dashboardsApi';
import { DimensionsSection, HealthSection, LineageSection, Section, UsageSection } from './MetricPageSections';
import { PeriodControl } from './PeriodControl';
import { useMetricChart, useMetricContext } from './useMetricPages';

const CHART_PX = 260;
const MONITOR_GRAINS = ['day', 'week', 'month'] as const;
const BTN = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500';

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  metric: CatalogMetric;
  period: MetricPeriod;
  onPeriod: (next: MetricPeriod) => void;
  onIndex: () => void;
  onOpenMetric: (name: string) => void;
  /** the query view with this widget */
  onExplore: (widget: DashboardWidget) => void;
  onRunSaved: (name: string) => void;
  onOpenDashboard: (slug: string) => void;
  onMonitor: (draft: MonitorDraft) => void;
  onOpenMonitors: () => void;
}

export function MetricPage({ projectId, catalog, metric, period, onPeriod, onIndex, onOpenMetric, onExplore, onRunSaved,
  onOpenDashboard, onMonitor, onOpenMonitors }: Props) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const ctx = useMetricContext(projectId);
  const chart = useMetricChart(projectId, metric.name, period);
  const { open: openFile } = useOpenInFiles(projectId);
  const uid = ctx.metricUids.get(metric.name) ?? null;
  const node = uid ? ctx.graph?.nodes.find((n) => n.unique_id === uid) ?? null : null;
  const lineage = useMemo(() => (ctx.graph && uid ? metricLineage(ctx.graph, uid) : null), [ctx.graph, uid]);
  const usage = useMemo(() => metricUsage(metric.name, uid, ctx.graph, catalog, ctx.dashboards), [metric.name, uid, ctx.graph, catalog, ctx.dashboards]);
  const issues = metricIssues(ctx.issues, metric.name, lineage?.semanticModels.map((n) => n.name) ?? metric.semantic_models);
  const result = chart.stored.data ? chartResult(chart.queries, chart.stored.data) : null;
  const { grain } = chart.queries;
  const label = metric.label || metric.name;
  const showInDag = (target: string) => navigate(`/projects/${projectId}/models?model=${encodeURIComponent(target)}`);
  // the explorer starts from this page's chart: the metric over time, same period and comparison
  const exploreWidget: DashboardWidget = { ...emptyExploreWidget([metric.name]), period: { current: period.current, compare: period.compare } };

  const saveQuery = async () => {
    const name = await promptDialog('Name for the saved query (lowercase, digits, underscores):', `${metric.name}_by_${grain}`,
      { title: 'Save as saved query', confirmLabel: 'Save' });
    if (!name) return;
    try {
      const { path } = await semanticApi.saveQuery(projectId, { metrics: [metric.name], group_by: [`${METRIC_TIME}__${grain}`], name: name.trim() });
      await alertDialog(`Added \`${name.trim()}\` to ${path}. It shows up under Saved queries once dbt re-parses.`, { title: 'Saved query added' });
    } catch (err) {
      await alertDialog(errorText(err) ?? 'Saving failed', { title: "Couldn't save the query" });
    }
  };

  return (
    <div className="flex flex-col gap-4 p-5 min-w-0">
      <button onClick={onIndex} className="flex items-center gap-1 self-start text-xs text-gray-500 hover:text-gray-200">
        <ArrowLeft className="w-3.5 h-3.5" />All metrics
      </button>
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-1 flex-1 min-w-[16rem]">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-semibold text-gray-100 truncate">{label}</h2>
            <span className={`shrink-0 px-1.5 py-px text-[10px] rounded border ${TYPE_CLS[metric.type] ?? TYPE_CLS.simple}`}>{metric.type}</span>
          </div>
          {metric.label && <span className="text-[11px] font-mono text-gray-500">{metric.name}</span>}
          {metric.description && <p className="max-w-3xl text-xs text-gray-400">{metric.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => onExplore(exploreWidget)} className={BTN} title="Break it down, filter it and chart it any way in the query view">
            <ExternalLink className="w-3.5 h-3.5" />Explore
          </button>
          <button onClick={() => setAdding(true)} className={BTN}><LayoutDashboard className="w-3.5 h-3.5" />Add to dashboard</button>
          <ProFeatureButton title="Watch it for anomalies (Pro)"
            onClick={() => onMonitor({ metric: metric.name, grain: (MONITOR_GRAINS as readonly string[]).includes(grain) ? grain as MonitorDraft['grain'] : 'day', dimension: null })}>
            <Radar className="w-3.5 h-3.5" />Monitor
          </ProFeatureButton>
          <button onClick={saveQuery} className={BTN}><Bookmark className="w-3.5 h-3.5" />Save as saved query</button>
          <ProFeatureButton title="Ask Wicky how it's calculated (Pro)"
            onClick={() => openWicky({ uniqueId: uid ?? undefined, question: `Explain the ${metric.name} metric: how it's calculated and what it depends on.` })}>
            <Bot className="w-3.5 h-3.5" />Ask Wicky
          </ProFeatureButton>
          {uid && node?.original_file_path && (
            <button onClick={() => openFile(uid)} className={BTN} title="Open its YAML in Files"><FileCode2 className="w-3.5 h-3.5" />YAML</button>
          )}
        </div>
      </header>

      <Section title="Over time" aside={
        <div className="flex flex-wrap items-center gap-2">
          {result?.ran_at && <span className="text-[11px] text-gray-500">Last run {relativeTime(result.ran_at)}</span>}
          <PeriodControl period={period} onChange={onPeriod} />
          <button onClick={() => chart.run()} disabled={chart.running}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
            {chart.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run
          </button>
        </div>
      }>
        <div style={{ height: CHART_PX }} className="min-w-0">
          {chart.stored.isLoading ? <p className="flex items-center justify-center h-full text-xs text-gray-500">Loading…</p>
            : chart.runError || chart.stored.error ? (
              <p className="flex items-center justify-center h-full px-4 text-center text-xs text-red-300">{errorText(chart.runError ?? chart.stored.error)}</p>
            ) : !result || result.status === 'not_run' ? (
              <p className="flex items-center justify-center h-full text-xs text-gray-500">Not run for this period yet — Run to see it.</p>
            ) : result.status === 'error' ? (
              <p className="flex items-center justify-center h-full px-4 text-center text-xs text-red-300">{result.error}</p>
            ) : (
              <TimeseriesWidget result={result} labels={new Map([[metric.name, label]])} height={CHART_PX} format={{}}
                widget={{ id: 'metric-page', type: 'timeseries', width: 100, height: CHART_PX, metrics: [metric.name], options: { style: 'line' } }} />
            )}
        </div>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4 min-w-0">
          <Section title="Definition">
            <SemanticDetails resourceType="metric" name={metric.name} label={metric.label} semantic={node?.semantic ?? null} />
          </Section>
          <DimensionsSection metric={metric} />
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <LineageSection lineage={lineage} onOpenMetric={onOpenMetric} onShowInDag={showInDag} onOpenFile={openFile} />
          <UsageSection usage={usage} onOpenDashboard={onOpenDashboard} onRunSaved={onRunSaved} onOpenMetric={onOpenMetric}
            dashboardTitle={(slug) => ctx.dashboards.find((d) => d.slug === slug)?.title ?? slug}
            onShowInDag={showInDag} onOpenFile={openFile} />
          <HealthSection issues={issues} checkedAt={ctx.checkedAt} monitor={ctx.monitors.get(metric.name)}
            onOpenCheck={() => navigate(`/projects/${projectId}/health?tab=semantic-layer`)} onOpenMonitors={onOpenMonitors} />
        </div>
      </div>

      {adding && (
        <AddToDashboardDialog projectId={projectId} body={chart.queries.currentBody} catalog={catalog} title={label}
          onClose={() => setAdding(false)} onAdded={(slug) => { setAdding(false); onOpenDashboard(slug); }} />
      )}
    </div>
  );
}
