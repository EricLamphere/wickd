// Metric summary: the period's total (its own query, never a sum of the trend), the previous
// period's total and the change (green/red by "higher is better"), and the trend with the
// previous period drawn faded underneath. Each part but the total can be turned off. Drag
// across the trend to zoom it on those periods (the total stays the whole period's);
// right-click it for the value menu (zoom, apply as the dashboard's date range, drill, investigate).
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { linePath, areaPath, nearestIndex, plotPoints } from '../../../../../lib/charts';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import {
  alignPrevious, changeRatio, changeTone, firstValue, formatChange, formatMetric, opt, rangeLabel, series,
  type MetricFormat,
} from '../dashboardModel';
import { formatTime } from '../../lib/metricSeries';
import { rangeBetween, zoomedIndexes } from '../timeRange';
import { PREVIOUS, seriesColor, SURFACE, TooltipBox } from './chartTheme';
import { rangePick, ResetZoom, useZoom, type Interaction, type ZoomProps } from './zoom';

const TONE = { good: 'text-emerald-400 bg-emerald-950/40', bad: 'text-red-400 bg-red-950/40', flat: 'text-gray-400 bg-gray-800/60' };

/** A trend point the pointer can rest on: its period and value, and the previous period's. */
interface TrendPoint { x: number; v: number; prev: number | null }

const TREND_W = 200;
const TREND_H = 40;
const TREND_PAD = 3;

function Trend({ points, previous, color, label, grain, format, interaction }: {
  points: TrendPoint[]; previous: (number | null)[]; color: string; label: string; grain: string | null; format: MetricFormat;
  interaction: Interaction;
}) {
  const [hover, setHover] = useState<{ i: number; clientX: number; clientY: number } | null>(null);
  // a drag in progress, as point indexes: where it started and where the pointer is
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const periodGrain = grain ?? 'day';
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
    if (drag) setDrag({ ...drag, b: i });
  };
  const onDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !hover) return;
    e.preventDefault(); // no text selection while dragging
    setDrag({ a: hover.i, b: hover.i });
  };
  const onUp = () => {
    if (drag && drag.a !== drag.b) interaction.onZoom(rangeBetween(points[drag.a].x, points[drag.b].x, periodGrain));
    setDrag(null);
  };
  const onMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const at = hover ? points[hover.i] : undefined;
    if (!interaction.onMenu || !at) return;
    e.preventDefault();
    e.stopPropagation();
    interaction.onMenu(rangePick(at.x, interaction.zoom, periodGrain), e.clientX, e.clientY);
  };
  const band = drag && drag.a !== drag.b
    ? { x: Math.min(pts[drag.a].x, pts[drag.b].x), w: Math.abs(pts[drag.a].x - pts[drag.b].x) } : null;
  const at = hover ? points[hover.i] : undefined;
  const dot = hover ? pts[hover.i] : undefined;
  return (
    <div className="relative w-full h-full cursor-crosshair select-none" onMouseMove={onMove} onMouseDown={onDown} onMouseUp={onUp}
      onMouseLeave={() => { setHover(null); setDrag(null); }} onContextMenu={onMenu}>
      <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none" className="w-full h-full" aria-hidden="true">
        {prevPts.length > 1 && (
          <path d={linePath(prevPts)} fill="none" stroke="rgb(var(--gray-500))" strokeOpacity={0.6} strokeWidth={1.25}
            strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        )}
        {band && <rect x={band.x} y={0} width={band.w} height={TREND_H} fill="rgb(var(--brand-500))" fillOpacity={0.18} />}
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
      {hover && at && !drag && createPortal(
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

export function SummaryWidget(props: {
  widget: DashboardWidget; result: WidgetResultDto; labels: Map<string, string>; format: MetricFormat;
} & ZoomProps) {
  const { widget, result, labels, format } = props;
  const interaction = useZoom(props);
  const { zoom } = interaction;
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
    <div className="relative grid gap-3 h-full" style={{ gridTemplateColumns: `repeat(${Math.max(1, metrics.length)}, minmax(0, 1fr))` }}>
      {zoom && showTrend && <ResetZoom zoom={zoom} onReset={() => interaction.onZoom(null)} />}
      {metrics.map((m, i) => {
        const value = total ? firstValue(total.columns, total.rows, m) : null;
        const previous = totalPrev?.status === 'ok' ? firstValue(totalPrev.columns, totalPrev.rows, m) : null;
        const ratio = changeRatio(value, previous);
        const change = formatChange(ratio);
        const points = trend?.status === 'ok' ? series(trend.columns, trend.rows, m, time) : [];
        const prevPoints = previousLine && trendPrev?.status === 'ok' ? alignPrevious(points, series(trendPrev.columns, trendPrev.rows, m, time)) : [];
        const allPoints = points.flatMap((p, k) => (p.v === null ? [] : [{ x: p.x, v: p.v, prev: prevPoints[k] ?? null }]));
        const kept = zoomedIndexes(allPoints.map((p) => p.x), zoom);
        const zoomed = kept.length < allPoints.length;
        const trendPoints = zoomed ? kept.map((k) => allPoints[k]) : allPoints;
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
                <Trend points={trendPoints} previous={zoomed ? trendPoints.map((p) => p.prev) : prevPoints} color={seriesColor(i)}
                  label={labels.get(m) ?? m} grain={result.grain} format={format} interaction={interaction} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
