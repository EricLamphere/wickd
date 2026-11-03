// Metric summary: the period's total (its own query, never a sum of the trend), the previous
// period's total and the change (green/red by "higher is better"), and the trend with the
// previous period drawn faded underneath. Each part but the total can be turned off.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { linePath, areaPath, nearestIndex, plotPoints } from '../../../../../lib/charts';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import {
  alignPrevious, changeRatio, changeTone, firstValue, formatChange, formatMetric, opt, rangeLabel, series,
  type MetricFormat,
} from '../dashboardModel';
import { formatTime } from '../../lib/metricSeries';
import { PREVIOUS, seriesColor, SURFACE, TooltipBox } from './chartTheme';

const TONE = { good: 'text-emerald-400 bg-emerald-950/40', bad: 'text-red-400 bg-red-950/40', flat: 'text-gray-400 bg-gray-800/60' };

/** A trend point the pointer can rest on: its period and value, and the previous period's. */
interface TrendPoint { x: number; v: number; prev: number | null }

const TREND_W = 200;
const TREND_H = 40;
const TREND_PAD = 3;

function Trend({ points, previous, color, label, grain, format }: {
  points: TrendPoint[]; previous: (number | null)[]; color: string; label: string; grain: string | null; format: MetricFormat;
}) {
  const [hover, setHover] = useState<{ i: number; clientX: number; clientY: number } | null>(null);
  const values = points.map((p) => p.v);
  const prev = previous.filter((v): v is number => v !== null);
  const max = Math.max(...values, ...prev, 0);
  const pts = plotPoints(values, TREND_W, TREND_H, TREND_PAD, max);
  const prevPts = prev.length > 1 ? plotPoints(prev, (TREND_W * (prev.length - 1)) / Math.max(1, values.length - 1), TREND_H, TREND_PAD, max) : [];
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    // the SVG stretches to the box (preserveAspectRatio none), so x scales straight across
    const i = nearestIndex(pts, ((e.clientX - box.left) / box.width) * TREND_W);
    setHover({ i, clientX: e.clientX, clientY: e.clientY });
  };
  const at = hover ? points[hover.i] : undefined;
  const dot = hover ? pts[hover.i] : undefined;
  return (
    <div className="relative w-full h-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none" className="w-full h-full" aria-hidden="true">
        {prevPts.length > 1 && (
          <path d={linePath(prevPts)} fill="none" stroke="rgb(var(--gray-500))" strokeOpacity={0.6} strokeWidth={1.25}
            strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        )}
        <path d={areaPath(pts, TREND_H)} fill={color} fillOpacity={0.15} />
        <path d={linePath(pts)} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
        {dot && (
          <line x1={dot.x} x2={dot.x} y1={0} y2={TREND_H} stroke="rgb(var(--text-muted))" strokeWidth={1}
            vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {/* the dot is HTML so the stretched SVG doesn't squash it into an ellipse */}
      {dot && (
        <span className="absolute w-2 h-2 -ml-1 -mt-1 rounded-full border pointer-events-none"
          style={{ borderColor: SURFACE, left: `${(dot.x / TREND_W) * 100}%`, top: `${(dot.y / TREND_H) * 100}%`, background: color }} />
      )}
      {/* in a portal: the widget body clips overflow, and the trend can be shorter than the box */}
      {hover && at && createPortal(
        <div className="fixed z-50 pointer-events-none" style={{
          left: hover.clientX + 12, top: hover.clientY + 12,
          transform: hover.clientX > window.innerWidth - 220 ? 'translateX(calc(-100% - 24px))' : undefined,
        }}>
          <TooltipBox title={grain ? formatTime(at.x, grain) : String(new Date(at.x).toLocaleDateString())} format={format} rows={[
            { label, color, value: at.v },
            ...(prevPts.length > 1 ? [{ label: `${label} (previous)`, color: PREVIOUS, value: at.prev, dashed: true }] : []),
          ]} />
        </div>,
        document.body,
      )}
    </div>
  );
}

export function SummaryWidget({ widget, result, labels, format }: {
  widget: DashboardWidget; result: WidgetResultDto; labels: Map<string, string>; format: MetricFormat;
}) {
  const metrics = widget.metrics ?? [];
  const higherIsBetter = opt(widget, 'higher_is_better', true);
  const showTrend = opt(widget, 'trend', true);
  const showChange = opt(widget, 'show_change', true);
  const showPrevious = opt(widget, 'show_previous', true);
  const previousLine = opt(widget, 'previous_line', true);
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
        const prevPoints = previousLine && trendPrev?.status === 'ok' ? alignPrevious(points, series(trendPrev.columns, trendPrev.rows, m, time)) : [];
        const trendPoints = points.flatMap((p, k) => (p.v === null ? [] : [{ x: p.x, v: p.v, prev: prevPoints[k] ?? null }]));
        return (
          <div key={m} className="flex flex-col gap-1 min-w-0 h-full" data-export-kpi="">
            {(metrics.length > 1 || widget.title) && <span className="text-[11px] text-gray-400 truncate">{labels.get(m) ?? m}</span>}
            <div className="flex items-baseline gap-2 min-w-0">
              <span className={`${narrow ? 'text-xl' : 'text-2xl'} font-semibold text-gray-100 tabular-nums truncate`} title={formatMetric(value, format)}>
                {formatMetric(value, format, narrow ? 'short' : true)}
              </span>
              {showChange && change && (
                <span className={`shrink-0 px-1.5 py-px text-[11px] font-medium rounded ${TONE[changeTone(ratio, higherIsBetter)]}`}>{change}</span>
              )}
            </div>
            {showPrevious && totalPrev && (
              <span className="text-[11px] text-gray-500 truncate" title={rangeLabel(result.previous)}>
                vs {formatMetric(previous, format, narrow ? 'short' : true)}{!narrow && result.previous ? ` · ${rangeLabel(result.previous)}` : ''}
              </span>
            )}
            {showTrend && trendPoints.length > 1 && (
              <div className="flex-1 min-h-[24px]">
                <Trend points={trendPoints} previous={prevPoints} color={seriesColor(i)} label={labels.get(m) ?? m}
                  grain={result.grain} format={format} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
