// The Explore tab's landing (plan 13): every metric as a card grouped by semantic model — type,
// a sparkline of its stored result for the chosen period (never runs on open; "Run all" runs
// every card in one dbt show), where it's used and whether it has issues. Click → its page.
import { useMemo, useState } from 'react';
import { AlertTriangle, Compass, Loader2, Play, Search } from 'lucide-react';
import { Sparkline } from '../../../../components/charts/Sparkline';
import type { CatalogMetric, QueryBatchItemDto, SemanticCatalogDto } from '../../../../lib/semanticApi';
import { relativeTime } from '../../lib/relativeTime';
import { statusStyle } from '../monitors/monitorView';
import { formatTime, formatValue, parseTime, toNumber } from '../lib/metricSeries';
import { chartQueries, groupMetrics, metricIssues, metricUsage, searchMetrics, usageCount, type MetricPeriod } from '../lib/metricPage';
import { TYPE_CLS } from '../MetricsSidebar';
import { PeriodControl } from './PeriodControl';
import { useMetricContext, useMetricSparklines } from './useMetricPages';

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  period: MetricPeriod;
  onPeriod: (next: MetricPeriod) => void;
  onOpen: (metric: string) => void;
  /** the query view, empty (to build a query from scratch) */
  onExplore: () => void;
}

function points(item: QueryBatchItemDto | undefined, metric: string): { t: number; v: number }[] {
  const r = item?.status === 'ok' ? item.result : null;
  if (!r) return [];
  const time = r.columns.findIndex((c) => c.startsWith('metric_time'));
  const value = r.columns.indexOf(metric);
  if (time < 0 || value < 0) return [];
  return r.rows
    .map((row) => ({ t: parseTime(row[time]), v: toNumber(row[value]) }))
    .filter((p): p is { t: number; v: number } => p.t !== null && p.v !== null)
    .sort((a, b) => a.t - b.t);
}

function Card({ metric, item, grain, usage, issues, monitor, onOpen }: {
  metric: CatalogMetric; item: QueryBatchItemDto | undefined; grain: string; usage: number; issues: number;
  monitor: ReturnType<typeof statusStyle> | null; onOpen: () => void;
}) {
  const pts = points(item, metric.name);
  return (
    <button onClick={onOpen} title={metric.description ?? undefined}
      className="flex flex-col gap-2 min-w-0 p-3 text-left rounded border border-gray-800 bg-surface-panel hover:border-gray-600">
      <div className="flex items-start gap-2 min-w-0">
        <span className="flex flex-col flex-1 min-w-0">
          <span className="text-xs font-medium text-gray-100 truncate">{metric.label || metric.name}</span>
          {metric.label && <span className="text-[10px] font-mono text-gray-500 truncate">{metric.name}</span>}
        </span>
        <span className={`shrink-0 px-1.5 py-px text-[10px] rounded border ${TYPE_CLS[metric.type] ?? TYPE_CLS.simple}`}>{metric.type}</span>
      </div>
      <div className="flex items-end gap-2 h-8">
        {pts.length > 1 ? (
          // the sparkline reads out the latest value (or the hovered one) itself
          <Sparkline values={pts.map((p) => p.v)} labels={pts.map((p) => formatTime(p.t, grain))} format={(v) => formatValue(v)} width={160} height={28} />
        ) : (
          <span className="text-[11px] text-gray-600">
            {item?.status === 'error' ? 'Error' : item?.status === 'ok' ? 'Not enough data' : 'Not run'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-gray-500">
        <span>{usage ? `Used in ${usage}` : 'Not used yet'}</span>
        {issues > 0 && <span className="flex items-center gap-0.5 text-amber-300"><AlertTriangle className="w-3 h-3" />{issues}</span>}
        {monitor && <span className={`px-1 rounded border ${monitor.pill}`}>{monitor.label}</span>}
        {item?.result?.ran_at && <span className="ml-auto">{relativeTime(item.result.ran_at)}</span>}
      </div>
    </button>
  );
}

export function MetricIndex({ projectId, catalog, period, onPeriod, onOpen, onExplore }: Props) {
  const [search, setSearch] = useState('');
  const shown = useMemo(() => searchMetrics(catalog.metrics, search), [catalog.metrics, search]);
  const names = useMemo(() => catalog.metrics.map((m) => m.name), [catalog.metrics]);
  const spark = useMetricSparklines(projectId, names, period);
  const ctx = useMetricContext(projectId);
  const grain = chartQueries(names[0] ?? '', period).grain;
  const notRun = names.filter((n) => spark.byMetric.get(n)?.status === 'not_run').length;

  return (
    <div className="flex flex-col gap-4 p-5 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-gray-100">Metrics</h2>
        <span className="text-[11px] text-gray-500">{catalog.metrics.length}</span>
        <label className="flex items-center gap-1.5 flex-1 min-w-[12rem] max-w-sm px-2 py-1 rounded border border-gray-700 bg-surface-app">
          <Search className="w-3.5 h-3.5 text-gray-500" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search metrics" aria-label="Search metrics"
            className="flex-1 min-w-0 bg-transparent text-xs text-gray-200 outline-none" />
        </label>
        <div className="flex-1" />
        <PeriodControl period={period} onChange={onPeriod} compare={false} />
        <button onClick={onExplore} title="Build a query: any metrics, broken down and filtered, as any widget"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">
          <Compass className="w-3.5 h-3.5" />Explore
        </button>
        <button onClick={() => spark.run()} disabled={spark.running || !names.length}
          title="Run every metric's chart for this period on the warehouse, in one batch"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
          {spark.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {notRun ? `Run all (${notRun} not run)` : 'Run all'}
        </button>
      </div>
      {spark.runError && <p className="text-xs text-red-300">{String((spark.runError as Error).message ?? spark.runError)}</p>}
      {shown.length === 0 && <p className="text-xs text-gray-500">No metric matches “{search}”.</p>}
      {groupMetrics(shown).map(([group, metrics]) => (
        <section key={group} className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{group}</h3>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))' }}>
            {metrics.map((m) => {
              const uid = ctx.metricUids.get(m.name) ?? null;
              const monitor = ctx.monitors.get(m.name);
              return (
                <Card key={m.name} metric={m} item={spark.byMetric.get(m.name)} grain={grain}
                  usage={usageCount(metricUsage(m.name, uid, ctx.graph, catalog, ctx.dashboards))}
                  issues={metricIssues(ctx.issues, m.name, m.semantic_models).length}
                  monitor={monitor?.status && monitor.status !== 'ok' ? statusStyle(monitor.status) : null}
                  onOpen={() => onOpen(m.name)} />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
