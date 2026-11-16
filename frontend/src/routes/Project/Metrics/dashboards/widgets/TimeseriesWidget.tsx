// Time series: each metric over time at the widget's grain; with a comparison, the previous
// period is a faded gray line lined up under the current one (period by period). Split by a
// dimension draws its top N values instead (no comparison then). Metrics whose scales differ
// 10× get their own charts (layout auto), else they share one. Drag across the chart to
// highlight periods: it zooms on them (Reset zoom goes back). Right-click offers the value menu
// for the highlighted periods (or the one under the pointer), e.g. apply them as the dashboard's
// date range.
import { useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardWidget, DateRange, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { formatTime } from '../../lib/metricSeries';
import {
  alignPrevious, formatMetric, opt, separateCharts, series, type MetricFormat, type MonitorOverlay, type Point,
} from '../dashboardModel';
import { AXIS_TICK, BAND, exportSeries, GRID, Legend, MARKER, PREVIOUS, seriesColor, SURFACE, TooltipBox } from './chartTheme';
import { toNumber } from '../../lib/metricSeries';
import { rangeBetween, zoomedIndexes } from '../timeRange';
import { rangePick, ResetZoom, useZoom, type Interaction, type ZoomProps } from './zoom';

interface Props extends ZoomProps {
  widget: DashboardWidget;
  result: WidgetResultDto;
  labels: Map<string, string>;
  height: number;
  format: MetricFormat;
  overlay?: MonitorOverlay | null;
}

interface Line_ {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  previous?: boolean;
}

interface ChartData {
  xs: number[];
  lines: Line_[];
}

function splitLines(columns: string[], rows: unknown[][], metric: string, time: string, dim: string, topN: number): ChartData {
  const m = columns.indexOf(metric);
  const t = columns.indexOf(time);
  const d = columns.indexOf(dim);
  if (m < 0 || t < 0 || d < 0) return { xs: [], lines: [] };
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(String(r[d] ?? '∅'), (totals.get(String(r[d] ?? '∅')) ?? 0) + Math.abs(toNumber(r[m]) ?? 0));
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
  const xs = [...new Set(series(columns, rows, metric, time).map((p) => p.x))];
  const byKey = new Map(top.map((k) => [k, new Map<number, number | null>()]));
  for (const r of rows) {
    const k = String(r[d] ?? '∅');
    const x = series([time, metric], [[r[t], r[m]]], metric, time)[0]?.x;
    if (x !== undefined) byKey.get(k)?.set(x, toNumber(r[m]));
  }
  return { xs, lines: top.map((k, i) => ({ key: `s${i}`, label: k, color: seriesColor(i), values: xs.map((x) => byKey.get(k)?.get(x) ?? null) })) };
}

function metricLines(widget: DashboardWidget, result: WidgetResultDto, metrics: string[], labels: Map<string, string>): ChartData {
  const time = `metric_time__${result.grain}`;
  const cur = result.queries.current;
  const prev = result.queries.current_previous;
  const split = opt<string | null>(widget, 'split_by', null);
  if (split) return splitLines(cur.columns, cur.rows, metrics[0], time, split, opt(widget, 'top_n', 5));
  const base: Point[] = series(cur.columns, cur.rows, metrics[0], time);
  const xs = base.map((p) => p.x);
  const lines: Line_[] = [];
  metrics.forEach((m, i) => {
    const points = series(cur.columns, cur.rows, m, time);
    const byX = new Map(points.map((p) => [p.x, p.v]));
    const label = labels.get(m) ?? m;
    lines.push({ key: `m${i}`, label, color: seriesColor(widget.metrics!.indexOf(m)), values: xs.map((x) => byX.get(x) ?? null) });
    if (prev?.status === 'ok') {
      lines.push({ key: `p${i}`, label: `${label} (previous)`, color: PREVIOUS, previous: true,
        values: alignPrevious(points, series(prev.columns, prev.rows, m, time)) });
    }
  });
  return { xs, lines };
}

/** The data cut to the zoomed periods. */
function zoomed(data: ChartData, zoom: DateRange | null): ChartData {
  const keep = zoomedIndexes(data.xs, zoom);
  if (keep.length === data.xs.length) return data;
  return { xs: keep.map((i) => data.xs[i]), lines: data.lines.map((l) => ({ ...l, values: keep.map((i) => l.values[i]) })) };
}

const pointX = (s: { activeLabel?: unknown } | null | undefined): number | null => {
  const x = Number(s?.activeLabel);
  return s?.activeLabel == null || Number.isNaN(x) ? null : x;
};

function Chart({ data, height, grain, format, style, zero, overlay, interaction }: {
  data: ChartData; height: number; grain: string; format: MetricFormat; style: string; zero: boolean; overlay?: MonitorOverlay | null;
  interaction: Interaction;
}) {
  const { zoom, onZoom, onMenu } = interaction;
  // a drag in progress: where it started and where the pointer is
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const rows = data.xs.map((x, i) => Object.fromEntries([['x', x], ...data.lines.map((l) => [l.key, l.values[i]]),
    ['band', overlay?.band.get(x) ?? null]]));
  const flagged = overlay ? overlay.flagged.flatMap((f) => {
    const i = data.xs.indexOf(f.x);
    const v = i >= 0 ? data.lines[0]?.values[i] : null;
    return v === null || v === undefined ? [] : [{ x: f.x, y: v, tone: f.tone }];
  }) : [];
  const stacked = style === 'stacked';
  return (
    <div className="flex flex-col gap-1 min-w-0" data-export-series={exportSeries('time', data.xs.map((x) => formatTime(x, grain)),
      data.lines.map((l) => ({ label: l.label, color: l.color, values: l.values })))}>
      <Legend items={data.lines.map((l) => ({ label: l.label, color: l.color, faded: l.previous }))} />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} style={{ cursor: 'crosshair', userSelect: 'none' }}
          onMouseDown={(s, e) => {
            const x = pointX(s);
            if (x !== null && (e as { button?: number }).button === 0) setDrag({ a: x, b: x });
          }}
          onMouseMove={(s) => {
            const x = pointX(s);
            if (x === null) return;
            setHovered(x);
            if (drag) setDrag({ ...drag, b: x });
          }}
          onMouseUp={() => {
            if (drag && drag.a !== drag.b) onZoom(rangeBetween(drag.a, drag.b, grain));
            setDrag(null);
          }}
          onMouseLeave={() => { setDrag(null); setHovered(null); }}
          onContextMenu={(s, e) => {
            const x = pointX(s) ?? hovered;
            if (!onMenu || x === null) return;
            e.preventDefault();
            onMenu(rangePick(x, zoom, grain), e.clientX, e.clientY);
          }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={AXIS_TICK}
            tickFormatter={(v: number) => formatTime(v, grain)} stroke={GRID} minTickGap={28} />
          <YAxis tick={AXIS_TICK} tickFormatter={(v: number) => formatMetric(v, format, true)} stroke={GRID} width={52}
            domain={zero ? [0, 'auto'] : ['auto', 'auto']} />
          <Tooltip isAnimationActive={false} cursor={{ stroke: 'rgb(var(--text-muted))', strokeWidth: 1 }}
            content={({ active, label }) => {
              const i = data.xs.indexOf(Number(label));
              if (!active || i < 0) return null;
              return <TooltipBox title={formatTime(Number(label), grain)} format={format}
                rows={data.lines.map((l) => ({ label: l.label, color: l.color, value: l.values[i] ?? null, dashed: l.previous }))} />;
            }} />
          {overlay && <Area dataKey="band" stroke="none" fill={BAND} isAnimationActive={false} connectNulls activeDot={false} />}
          {data.lines.map((l) => (l.previous ? (
            <Line key={l.key} dataKey={l.key} stroke={l.color} strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="4 3"
              dot={false} activeDot={false} isAnimationActive={false} connectNulls={false} />
          ) : style === 'line' ? (
            <Line key={l.key} dataKey={l.key} stroke={l.color} strokeWidth={2} dot={rows.length < 3 ? { r: 3, fill: l.color } : false}
              activeDot={{ r: 4, fill: l.color, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
          ) : (
            <Area key={l.key} dataKey={l.key} stroke={l.color} fill={l.color} fillOpacity={stacked ? 0.35 : 0.15} strokeWidth={2}
              stackId={stacked ? 'stack' : undefined} isAnimationActive={false} connectNulls={false} />
          )))}
          {drag && drag.a !== drag.b && (
            <ReferenceArea x1={Math.min(drag.a, drag.b)} x2={Math.max(drag.a, drag.b)} fill="rgb(var(--brand-500))" fillOpacity={0.15}
              stroke="rgb(var(--brand-500))" strokeOpacity={0.5} ifOverflow="hidden" />
          )}
          {flagged.length > 0 && (
            <Scatter data={flagged} dataKey="y" isAnimationActive={false}
              shape={(p: { cx?: number; cy?: number; payload?: { tone: 'fail' | 'warn' } }) => (
                <circle cx={p.cx} cy={p.cy} r={4} fill={MARKER[p.payload?.tone ?? 'warn']} stroke={SURFACE} strokeWidth={1.5} />
              )} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TimeseriesWidget(props: Props) {
  const { widget, result, labels, height, format, overlay } = props;
  const interaction = useZoom(props);
  const { zoom } = interaction;
  const reset = zoom ? <ResetZoom zoom={zoom} onReset={() => interaction.onZoom(null)} /> : null;
  const metrics = widget.metrics ?? [];
  const cur = result.queries.current;
  const grain = result.grain ?? 'day';
  const style = opt(widget, 'style', 'line');
  const zero = opt(widget, 'zero_baseline', true);
  const split = opt<string | null>(widget, 'split_by', null);
  const maxima = metrics.map((m) => Math.max(0, ...series(cur.columns, cur.rows, m, `metric_time__${grain}`).map((p) => Math.abs(p.v ?? 0))));
  const separate = !split && separateCharts(maxima, opt(widget, 'layout', 'auto'));
  if (!separate) {
    const data = zoomed(metricLines(widget, result, metrics, labels), zoom);
    if (!data.xs.length) return <p className="flex items-center justify-center h-full text-xs text-gray-500">No rows for this period.</p>;
    return (
      <div className="relative h-full">
        {reset}
        <Chart data={data} height={height - (data.lines.length > 1 ? 16 : 0)} grain={grain} format={format} style={style} zero={zero}
          overlay={metrics.length === 1 ? overlay : null} interaction={interaction} />
      </div>
    );
  }
  const each = Math.max(56, Math.floor(height / metrics.length) - 30);
  return (
    <div className="relative flex flex-col gap-2 h-full overflow-hidden">
      {reset}
      {metrics.map((m) => (
        <div key={m} className="min-w-0">
          <span className="text-[10px] text-gray-400">{labels.get(m) ?? m}</span>
          <Chart data={zoomed(metricLines(widget, result, [m], labels), zoom)} height={each} grain={grain} format={format} style={style} zero={zero}
            interaction={interaction} />
        </div>
      ))}
    </div>
  );
}
