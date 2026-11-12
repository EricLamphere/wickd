// A metric page's numbers: the period's total against the comparison, the metric over time,
// and its top values by a dimension — drawn by the dashboards' renderers from one batch of
// stored results; what's missing runs by itself when the page opens or the period or dimension
// changes (once each; Run runs it again), in one dbt show. Each chart's ⋯
// menu: Add to dashboard (as that widget, following the dashboard's period), Save as saved
// query (reviewed before it's written), then the data
// items every chart menu shares (chartMenu/useChartExports: View SQL, Open in Workspace,
// Download PNG / CSV).
import { useRef, useState } from 'react';
import { LayoutDashboard, Loader2, Play } from 'lucide-react';
import type { CatalogMetric, SemanticCatalogDto } from '../../../../lib/semanticApi';
import type { DashboardWidget, WidgetResultDto } from '../../../../lib/dashboardsApi';
import { relativeTime } from '../../lib/relativeTime';
import { AddToDashboardDialog } from '../dashboards/AddToDashboardDialog';
import { sharedDimensions } from '../dashboards/dashboardModel';
import { errorText } from '../dashboards/useDashboards';
import { BarWidget } from '../dashboards/widgets/BarWidget';
import { WidgetMenuButton } from '../dashboards/widgets/WidgetMenu';
import { SummaryWidget } from '../dashboards/widgets/SummaryWidget';
import { TimeseriesWidget } from '../dashboards/widgets/TimeseriesWidget';
import { BREAKDOWN_TOP_N, pageResult, WIDGET_ROLES, type MetricPeriod, type PageRole } from '../lib/metricPage';
import { compareLabel, currentLabel, rangeLabel } from '../dashboards/periods';
import { PeriodControl } from './PeriodControl';
import { useChartExports } from '../chartMenu/useChartExports';
import { useSaveAsSavedQuery } from '../chartMenu/useSaveAsSavedQuery';
import { useMetricPageData } from './useMetricPages';

const CHART_PX = 240;
const FIELD = 'px-1.5 py-0.5 text-[11px] rounded border border-gray-700 bg-surface-app text-gray-300 outline-none focus:border-brand-600';

/** A chart card; `cardRef` gets its wrapper, which Download PNG draws (the card is its one widget). */
function Card({ id, title, aside, menu, className = '', cardRef, children }: {
  id: string; title: React.ReactNode; aside?: React.ReactNode; menu: React.ReactNode; className?: string;
  cardRef: (el: HTMLDivElement | null) => void; children: React.ReactNode;
}) {
  return (
    <div ref={cardRef} className={`min-w-0 ${className}`}>
      <div data-widget-id={id} className="flex flex-col gap-2 h-full min-w-0 p-3 rounded-lg border border-gray-800 bg-surface-panel">
        <div className="flex items-center gap-2 min-h-[22px]">
          <h3 className="flex-1 text-xs font-medium text-gray-300 truncate">{title}</h3>
          {aside}
          {menu}
        </div>
        <div style={{ height: CHART_PX }} className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

function Message({ tone = 'muted', children }: { tone?: 'muted' | 'error'; children: React.ReactNode }) {
  return (
    <p className={`flex items-center justify-center h-full px-4 text-center text-xs ${tone === 'error' ? 'text-red-300' : 'text-gray-500'}`}>{children}</p>
  );
}

/** The chart, or why there isn't one (loading, not run, an error). */
function ChartState({ loading, running, error, result, children }: {
  loading: boolean; running: boolean; error: unknown; result: WidgetResultDto | null; children: (r: WidgetResultDto) => React.ReactNode;
}) {
  if (loading) return <Message>Loading…</Message>;
  if (error) return <Message tone="error">{errorText(error)}</Message>;
  if (result?.status === 'running' || ((!result || result.status === 'not_run') && running)) {
    return <Message><Loader2 className="inline w-3.5 h-3.5 mr-1.5 animate-spin" />Running on the warehouse…</Message>;
  }
  if (!result || result.status === 'not_run') return <Message>Not run for this period yet — Run to see it.</Message>;
  if (result.status === 'error') return <Message tone="error">{result.error}</Message>;
  return <>{children(result)}</>;
}

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  metric: CatalogMetric;
  label: string;
  period: MetricPeriod;
  onPeriod: (next: MetricPeriod) => void;
  onOpenDashboard: (slug: string) => void;
}

export function MetricCharts({ projectId, catalog, metric, label, period, onPeriod, onOpenDashboard }: Props) {
  const dimensions = sharedDimensions(catalog, [metric.name]);
  const [picked, setPicked] = useState<string | null>(null);
  const dimension = picked && dimensions.includes(picked) ? picked : dimensions[0] ?? null;
  const data = useMetricPageData(projectId, metric.name, period, dimension);
  const items = data.stored.data;
  const result = (roles: Record<string, PageRole>) => (items ? pageResult(data.queries, items, roles) : null);
  const summary = result(WIDGET_ROLES.summary);
  const overTime = result(WIDGET_ROLES.timeseries);
  const byDimension = dimension ? result(WIDGET_ROLES.bar) : null;
  // when the oldest chart ran, once every chart has a result
  const shown = [summary, overTime, ...(dimension ? [byDimension] : [])];
  const ranAt = shown.every((r) => r && r.status !== 'not_run')
    ? shown.map((r) => r?.ran_at).filter((x): x is string => !!x).sort()[0] : undefined;
  const labels = new Map([[metric.name, label]]);
  const loading = data.stored.isLoading;
  const error = data.runError ?? data.stored.error;
  const widget = (w: Pick<DashboardWidget, 'type' | 'width' | 'height' | 'options'>): DashboardWidget => ({ ...w, id: 'metric-page', metrics: [metric.name] });
  const [adding, setAdding] = useState<DashboardWidget | null>(null);
  // the charts as widgets (Add to dashboard starts from these)
  const summaryWidget = widget({ type: 'summary', width: 33, height: CHART_PX });
  const overTimeWidget = widget({ type: 'timeseries', width: 66, height: CHART_PX, options: { style: 'line' } });
  const barWidget = dimension
    ? widget({ type: 'bar', width: 100, height: CHART_PX, options: { dimension, top_n: BREAKDOWN_TOP_N, show_previous: true } }) : null;
  const exports = useChartExports(projectId);
  const saveQuery = useSaveAsSavedQuery(projectId);
  const cards = useRef<Record<string, HTMLDivElement | null>>({});
  const cardRef = (id: string) => (el: HTMLDivElement | null) => { cards.current[id] = el; };
  const periodText = [
    `${currentLabel(period.current)}${data.queries.current ? ` (${rangeLabel(data.queries.current)})` : ''}`,
    data.queries.previous ? `vs ${compareLabel(period.compare).toLowerCase()} (${rangeLabel(data.queries.previous)})` : null,
  ].filter(Boolean).join(' ');
  const menu = (id: string, chart: string, w: DashboardWidget, r: WidgetResultDto | null) => (
    <WidgetMenuButton items={[
      { label: 'Add to dashboard', icon: <LayoutDashboard className="w-3.5 h-3.5" />, onClick: () => setAdding(w) },
      saveQuery.item(r),
      ...exports.items({
        result: r, element: () => cards.current[id] ?? null, title: `${label} — ${chart}`, name: [metric.name, chart],
        subtitle: [periodText, r?.ran_at ? `data queried ${new Date(r.ran_at).toLocaleString()}` : null].filter(Boolean).join(' · '),
      }),
    ]} />
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 pb-1.5 border-b border-gray-800">
        <h2 className="flex-1 text-sm font-semibold text-gray-200">Numbers</h2>
        {ranAt && <span className="text-[11px] text-gray-500">Last run {relativeTime(ranAt)}</span>}
        <PeriodControl period={period} onChange={onPeriod} />
        <button onClick={() => data.run()} disabled={data.running} title="Run these charts on the warehouse (stored results are reused)"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
          {data.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run
        </button>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card id="total" cardRef={cardRef('total')} title="Total" menu={menu('total', 'Total', summaryWidget, summary)}>
          <ChartState loading={loading} running={data.running} error={error} result={summary}>
            {(r) => <SummaryWidget widget={summaryWidget} result={r} labels={labels} format={{}} />}
          </ChartState>
        </Card>
        <Card id="over-time" cardRef={cardRef('over-time')} title="Over time" className="lg:col-span-2"
          menu={menu('over-time', 'Over time', overTimeWidget, overTime)}>
          <ChartState loading={loading} running={data.running} error={error} result={overTime}>
            {(r) => <TimeseriesWidget result={r} labels={labels} height={CHART_PX} format={{}} widget={overTimeWidget} />}
          </ChartState>
        </Card>
        {dimension && barWidget && (
          <Card id="by-dimension" cardRef={cardRef('by-dimension')} className="lg:col-span-3" title={`Top ${BREAKDOWN_TOP_N} by dimension`}
            menu={menu('by-dimension', `Top ${BREAKDOWN_TOP_N} by ${dimension}`, barWidget, byDimension)} aside={
            <select value={dimension} onChange={(e) => setPicked(e.target.value)} aria-label="Break it down by" className={FIELD} data-export-hide="">
              {dimensions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          }>
            <ChartState loading={loading} running={data.running} error={error} result={byDimension}>
              {(r) => <BarWidget result={r} labels={labels} height={CHART_PX} format={{}} onPick={null} onMenu={null} selected={null} widget={barWidget} />}
            </ChartState>
          </Card>
        )}
      </div>
      {adding && (
        <AddToDashboardDialog projectId={projectId} widget={adding} catalog={catalog} title={label}
          onClose={() => setAdding(null)} onAdded={(slug) => { setAdding(null); onOpenDashboard(slug); }} />
      )}
      {exports.modal}
      {saveQuery.modal}
    </section>
  );
}
