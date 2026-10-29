// A widget's content by type, plus the states before there's data (no metric yet, not run,
// error). The Pro monitor band is fetched here for an eligible time series.
import { AlertTriangle, Loader2, MousePointer2, Play } from 'lucide-react';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import type { MonitorDto } from '../../../../../lib/monitorsApi';
import { useMonitorSeries } from '../../monitors/useMonitors';
import { monitorForWidget, opt, overlayFromPoints, requiredRole, type MetricFormat } from '../dashboardModel';
import type { Pick } from '../drill';
import { BarWidget } from './BarWidget';
import { LeaderboardWidget } from './LeaderboardWidget';
import { SummaryWidget } from './SummaryWidget';
import { TableWidget } from './TableWidget';
import { TextWidget } from './TextWidget';
import { TimeseriesWidget } from './TimeseriesWidget';

export interface BodyProps {
  projectId: number;
  widget: DashboardWidget;
  result: WidgetResultDto | undefined;
  labels: Map<string, string>;
  height: number;
  loading: boolean;
  refreshing: boolean;
  monitors: MonitorDto[];
  /** a dashboard filter was applied to this widget (no monitor band then) */
  filtered: boolean;
  /** its results are for other settings (a change is being saved and run) */
  updating: boolean;
  onRun: () => void;
  /** click a value (a bar or segment, a Top N row): show it over time */
  onPick: ((pick: Pick) => void) | null;
  /** right-click a value: its menu at the pointer */
  onPickMenu: ((pick: Pick, x: number, y: number) => void) | null;
  /** the drilled value, highlighted */
  drilled: Pick | null;
}

export function formatOf(widget: DashboardWidget): MetricFormat {
  return { format: opt(widget, 'format', 'number'), decimals: opt<number | null>(widget, 'decimals', null), currency: opt(widget, 'currency', 'USD') };
}

function Message({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 h-full px-3 text-center text-xs ${tone === 'error' ? 'text-red-300' : 'text-gray-500'}`}>
      {children}
    </div>
  );
}

export function WidgetBody(props: BodyProps) {
  const { projectId, widget, result, labels, height, loading, refreshing, monitors, filtered, updating, onRun, onPick, onPickMenu, drilled } = props;
  // Top N picks one value of the widget's dimension (bars build their own picks: stacked segments have two)
  const dimension = opt<string>(widget, 'dimension', '');
  const single = (value: string): Pick => ({ values: [{ dimension, value }] });
  const pick = onPick && dimension ? (value: string) => onPick(single(value)) : null;
  const menu = onPickMenu && dimension ? (value: string, x: number, y: number) => onPickMenu(single(value), x, y) : null;
  const selected = drilled && drilled.values.length === 1 && drilled.values[0].dimension === dimension ? drilled.values[0].value : null;
  const monitor = result?.status === 'ok' ? monitorForWidget(monitors, widget, result.grain, filtered) : null;
  const band = useMonitorSeries(projectId, monitor?.id ?? null, '');
  if (widget.type === 'text') return <TextWidget body={opt(widget, 'body', '')} />;
  if (!widget.metrics?.length) {
    return (
      <Message>
        <MousePointer2 className="w-4 h-4" />
        <span>Drag a metric from the left onto this widget.</span>
      </Message>
    );
  }
  if (!result) return <Message>{loading ? 'Loading…' : 'No result'}</Message>;
  if (updating) return <Message><Loader2 className="w-4 h-4 animate-spin" />Updating…</Message>;
  if (result.status === 'error') {
    return <Message tone="error"><AlertTriangle className="w-4 h-4" /><span className="whitespace-pre-wrap line-clamp-6">{result.error}</span></Message>;
  }
  // Results from before a type change (a summary's `total`, no `current`) can't draw this type
  const role = requiredRole(widget.type);
  const stale = role !== null && !result.queries[role];
  if (result.status === 'not_run' || stale) {
    return (
      <Message>
        {refreshing ? <><Loader2 className="w-4 h-4 animate-spin" />Running…</> : (
          <>
            <span>No result for these settings yet (new widget, changed settings or definitions).</span>
            <button onClick={onRun} className="flex items-center gap-1 px-2 py-1 rounded border border-gray-700 text-gray-300 hover:border-gray-500" data-export-hide="">
              <Play className="w-3 h-3" />Run
            </button>
          </>
        )}
      </Message>
    );
  }
  const format = formatOf(widget);
  switch (widget.type) {
    case 'summary': return <SummaryWidget widget={widget} result={result} labels={labels} format={format} />;
    case 'timeseries': return <TimeseriesWidget widget={widget} result={result} labels={labels} height={height} format={format}
      overlay={monitor && band.data ? overlayFromPoints(band.data.points) : null} />;
    case 'bar': return <BarWidget widget={widget} result={result} labels={labels} height={height} format={format}
      onPick={dimension ? onPick : null} onMenu={dimension ? onPickMenu : null} selected={drilled} />;
    case 'leaderboard': return <LeaderboardWidget widget={widget} result={result} format={format}
      higherIsBetter={opt(widget, 'higher_is_better', true)} onPick={pick} onMenu={menu} selected={selected} />;
    case 'table': return <TableWidget widget={widget} result={result} labels={labels} onMenu={onPickMenu} />;
    default: return null;
  }
}
