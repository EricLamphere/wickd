// A metric's page (plan 13), laid out like a doc: the metric as the title, its description and
// facts (how it's calculated, filter, inputs) under it, the actions that start from a metric
// (Investigate — the query view in a modal, where Debug and Compare live — YAML, then the Pro ones: monitor, Wicky), its numbers for a chosen period (MetricCharts: total, over time, top
// values by a dimension, each with a ⋯ menu: Add to dashboard, downloads…; stored results first,
// Run for fresh), then its dimensions, lineage,
// usage and health.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bot, FileCode2, Microscope, Radar } from 'lucide-react';
import type { CatalogMetric, SemanticCatalogDto } from '../../../../lib/semanticApi';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { useOpenInFiles } from '../../lib/openInFiles';
import { openWicky } from '../../lib/wickyEvents';
import type { MonitorDraft } from '../monitors/CreateMonitorDialog';
import { TYPE_CLS } from '../MetricsSidebar';
import { chartQueries, metricIssues, metricLineage, metricUsage, type MetricPeriod } from '../lib/metricPage';
import { emptyExploreWidget } from '../lib/exploreWidget';
import type { DashboardWidget } from '../../../../lib/dashboardsApi';
import { MetricCharts } from './MetricCharts';
import { MetricFacts } from './MetricFacts';
import { DimensionsSection, HealthSection, LineageSection, UsageSection } from './MetricPageSections';
import { useMetricContext } from './useMetricPages';

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
  /** Investigate: the query view with this widget */
  onExplore: (widget: DashboardWidget) => void;
  onRunSaved: (name: string) => void;
  onOpenDashboard: (slug: string) => void;
  onMonitor: (draft: MonitorDraft) => void;
  onOpenMonitors: () => void;
}

export function MetricPage({ projectId, catalog, metric, period, onPeriod, onIndex, onOpenMetric, onExplore, onRunSaved,
  onOpenDashboard, onMonitor, onOpenMonitors }: Props) {
  const navigate = useNavigate();
  const ctx = useMetricContext(projectId);
  const chart = useMemo(() => chartQueries(metric.name, period), [metric.name, period]);
  const { open: openFile } = useOpenInFiles(projectId);
  const uid = ctx.metricUids.get(metric.name) ?? null;
  const node = uid ? ctx.graph?.nodes.find((n) => n.unique_id === uid) ?? null : null;
  const lineage = useMemo(() => (ctx.graph && uid ? metricLineage(ctx.graph, uid) : null), [ctx.graph, uid]);
  const usage = useMemo(() => metricUsage(metric.name, uid, ctx.graph, catalog, ctx.dashboards), [metric.name, uid, ctx.graph, catalog, ctx.dashboards]);
  const issues = metricIssues(ctx.issues, metric.name, lineage?.semanticModels.map((n) => n.name) ?? metric.semantic_models);
  const { grain } = chart;
  const label = metric.label || metric.name;
  const showInDag = (target: string) => navigate(`/projects/${projectId}/models?model=${encodeURIComponent(target)}`);
  // the explorer starts from this page's chart: the metric over time, same period and comparison
  const exploreWidget: DashboardWidget = { ...emptyExploreWidget([metric.name]), period: { current: period.current, compare: period.compare } };


  return (
    <article className="flex flex-col gap-8 w-full max-w-6xl mx-auto px-8 py-6 min-w-0">
      <header className="flex flex-col gap-4">
        <button onClick={onIndex} className="flex items-center gap-1 self-start text-xs text-gray-500 hover:text-gray-200">
          <ArrowLeft className="w-3.5 h-3.5" />All metrics
        </button>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-2xl font-semibold text-gray-100 truncate">{label}</h1>
            <span className={`shrink-0 px-2 py-0.5 text-[11px] rounded-full border ${TYPE_CLS[metric.type] ?? TYPE_CLS.simple}`}>{metric.type}</span>
          </div>
          {metric.label && <span className="text-xs font-mono text-gray-500">{metric.name}</span>}
          {metric.description
            ? <p className="max-w-3xl mt-1 text-sm leading-relaxed text-gray-300">{metric.description}</p>
            : <p className="mt-1 text-sm italic text-gray-500">No description.</p>}
        </div>
        <MetricFacts metric={metric} semantic={node?.semantic ?? null} onOpenMetric={onOpenMetric} />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button onClick={() => onExplore(exploreWidget)} title="Break it down, filter it, chart it any way, debug it and compare it"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500">
            <Microscope className="w-3.5 h-3.5" />Investigate
          </button>
          {uid && node?.original_file_path && (
            <button onClick={() => openFile(uid)} className={BTN} title="Open its YAML in Files"><FileCode2 className="w-3.5 h-3.5" />YAML</button>
          )}
          {/* Pro actions, together after the rest */}
          <span className="w-px h-5 mx-1 bg-gray-800" aria-hidden="true" />
          <ProFeatureButton title="Watch it for anomalies (Pro)"
            onClick={() => onMonitor({ metric: metric.name, grain: (MONITOR_GRAINS as readonly string[]).includes(grain) ? grain as MonitorDraft['grain'] : 'day', dimension: null })}>
            <Radar className="w-3.5 h-3.5" />Monitor
          </ProFeatureButton>
          <ProFeatureButton title="Ask Wicky how it's calculated (Pro)"
            onClick={() => openWicky({ uniqueId: uid ?? undefined, question: `Explain the ${metric.name} metric: how it's calculated and what it depends on.` })}>
            <Bot className="w-3.5 h-3.5" />Ask Wicky
          </ProFeatureButton>
        </div>
      </header>

      <MetricCharts projectId={projectId} catalog={catalog} metric={metric} label={label} period={period} onPeriod={onPeriod}
        onOpenDashboard={onOpenDashboard} />

      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-8 min-w-0">
          <DimensionsSection metric={metric} />
          <HealthSection issues={issues} checkedAt={ctx.checkedAt} monitor={ctx.monitors.get(metric.name)}
            onOpenCheck={() => navigate(`/projects/${projectId}/health?tab=semantic-layer`)} onOpenMonitors={onOpenMonitors} />
        </div>
        <div className="flex flex-col gap-8 min-w-0">
          <LineageSection lineage={lineage} onOpenMetric={onOpenMetric} onShowInDag={showInDag} onOpenFile={openFile} />
          <UsageSection usage={usage} onOpenDashboard={onOpenDashboard} onRunSaved={onRunSaved} onOpenMetric={onOpenMetric}
            dashboardTitle={(slug) => ctx.dashboards.find((d) => d.slug === slug)?.title ?? slug}
            onShowInDag={showInDag} onOpenFile={openFile} />
        </div>
      </div>

    </article>
  );
}
