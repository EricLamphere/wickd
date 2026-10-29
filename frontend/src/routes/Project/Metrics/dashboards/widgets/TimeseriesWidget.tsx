// Time series: each metric over time at the widget's grain; with a comparison, the previous
// period is a faded gray line lined up under the current one (period by period). Split by a
// dimension draws its top N values instead (no comparison then). Metrics whose scales differ
// 10× get their own charts (layout auto), else they share one.
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { formatTime } from '../../lib/metricSeries';
import {
  alignPrevious, formatMetric, opt, separateCharts, series, type MetricFormat, type MonitorOverlay, type Point,
} from '../dashboardModel';
import { AXIS_TICK, BAND, exportSeries, GRID, Legend, MARKER, PREVIOUS, seriesColor, SURFACE, TooltipBox } from './chartTheme';
import { toNumber } from '../../lib/metricSeries';

interface Props {
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

function Chart({ data, height, grain, format, style, zero, overlay }: {
  data: ChartData; height: number; grain: string; format: MetricFormat; style: string; zero: boolean; overlay?: MonitorOverlay | null;
}) {
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
        <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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

export function TimeseriesWidget({ widget, result, labels, height, format, overlay }: Props) {
  const metrics = widget.metrics ?? [];
  const cur = result.queries.current;
  const grain = result.grain ?? 'day';
  const style = opt(widget, 'style', 'line');
  const zero = opt(widget, 'zero_baseline', true);
  const split = opt<string | null>(widget, 'split_by', null);
  const maxima = metrics.map((m) => Math.max(0, ...series(cur.columns, cur.rows, m, `metric_time__${grain}`).map((p) => Math.abs(p.v ?? 0))));
  const separate = !split && separateCharts(maxima, opt(widget, 'layout', 'auto'));
  if (!separate) {
    const data = metricLines(widget, result, metrics, labels);
    if (!data.xs.length) return <p className="flex items-center justify-center h-full text-xs text-gray-500">No rows for this period.</p>;
    return <Chart data={data} height={height - (data.lines.length > 1 ? 16 : 0)} grain={grain} format={format} style={style} zero={zero}
      overlay={metrics.length === 1 ? overlay : null} />;
  }
  const each = Math.max(56, Math.floor(height / metrics.length) - 30);
  return (
    <div className="flex flex-col gap-2 h-full overflow-hidden">
      {metrics.map((m) => (
        <div key={m} className="min-w-0">
          <span className="text-[10px] text-gray-400">{labels.get(m) ?? m}</span>
          <Chart data={metricLines(widget, result, [m], labels)} height={each} grain={grain} format={format} style={style} zero={zero} />
        </div>
      ))}
    </div>
  );
}
