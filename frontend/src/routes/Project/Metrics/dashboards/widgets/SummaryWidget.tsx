// Metric summary: the period's total (its own query, never a sum of the trend), the previous
// period's total and the change (green/red by "higher is better"), and the trend with the
// previous period drawn faded underneath.
import { linePath, areaPath, plotPoints } from '../../../../../lib/charts';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import {
  alignPrevious, changeRatio, changeTone, firstValue, formatChange, formatMetric, opt, rangeLabel, series,
  type MetricFormat,
} from '../dashboardModel';
import { seriesColor } from './chartTheme';

const TONE = { good: 'text-emerald-400 bg-emerald-950/40', bad: 'text-red-400 bg-red-950/40', flat: 'text-gray-400 bg-gray-800/60' };

function Trend({ values, previous, color }: { values: number[]; previous: (number | null)[]; color: string }) {
  const w = 200;
  const h = 40;
  const prev = previous.filter((v): v is number => v !== null);
  const max = Math.max(...values, ...prev, 0);
  const pts = plotPoints(values, w, h, 3, max);
  const prevPts = prev.length > 1 ? plotPoints(prev, (w * (prev.length - 1)) / Math.max(1, values.length - 1), h, 3, max) : [];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-full" aria-hidden="true">
      {prevPts.length > 1 && (
        <path d={linePath(prevPts)} fill="none" stroke="rgb(var(--gray-500))" strokeOpacity={0.6} strokeWidth={1.25}
          strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
      )}
      <path d={areaPath(pts, h)} fill={color} fillOpacity={0.15} />
      <path d={linePath(pts)} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function SummaryWidget({ widget, result, labels, format }: {
  widget: DashboardWidget; result: WidgetResultDto; labels: Map<string, string>; format: MetricFormat;
}) {
  const metrics = widget.metrics ?? [];
  const higherIsBetter = opt(widget, 'higher_is_better', true);
  const showTrend = opt(widget, 'trend', true);
  const { total, total_previous: totalPrev, trend, trend_previous: trendPrev } = result.queries;
  const time = `metric_time__${result.grain}`;
  // per metric, a narrow widget gets short numbers (12.3K) so they fit
  const narrow = widget.width / Math.max(1, metrics.length) <= 26;
  return (
    <div className="grid gap-3 h-full" style={{ gridTemplateColumns: `repeat(${Math.max(1, metrics.length)}, minmax(0, 1fr))` }}>
      {metrics.map((m, i) => {
        const value = total ? firstValue(total.columns, total.rows, m) : null;
        const previous = totalPrev?.status === 'ok' ? firstValue(totalPrev.columns, totalPrev.rows, m) : null;
        const ratio = changeRatio(value, previous);
        const change = formatChange(ratio);
        const points = trend?.status === 'ok' ? series(trend.columns, trend.rows, m, time) : [];
        const prevPoints = trendPrev?.status === 'ok' ? alignPrevious(points, series(trendPrev.columns, trendPrev.rows, m, time)) : [];
        const values = points.map((p) => p.v).filter((v): v is number => v !== null);
        return (
          <div key={m} className="flex flex-col gap-1 min-w-0 h-full" data-export-kpi="">
            {(metrics.length > 1 || widget.title) && <span className="text-[11px] text-gray-400 truncate">{labels.get(m) ?? m}</span>}
            <div className="flex items-baseline gap-2 min-w-0">
              <span className={`${narrow ? 'text-xl' : 'text-2xl'} font-semibold text-gray-100 tabular-nums truncate`} title={formatMetric(value, format)}>
                {formatMetric(value, format, narrow ? 'short' : true)}
              </span>
              {change && (
                <span className={`shrink-0 px-1.5 py-px text-[11px] font-medium rounded ${TONE[changeTone(ratio, higherIsBetter)]}`}>{change}</span>
              )}
            </div>
            {totalPrev && (
              <span className="text-[11px] text-gray-500 truncate" title={rangeLabel(result.previous)}>
                vs {formatMetric(previous, format, narrow ? 'short' : true)}{!narrow && result.previous ? ` · ${rangeLabel(result.previous)}` : ''}
              </span>
            )}
            {showTrend && values.length > 1 && (
              <div className="flex-1 min-h-[24px]"><Trend values={values} previous={prevPoints} color={seriesColor(i)} /></div>
            )}
          </div>
        );
      })}
    </div>
  );
}
