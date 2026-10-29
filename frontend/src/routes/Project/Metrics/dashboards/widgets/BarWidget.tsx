// Bar chart: one bar per value of the widget's dimension; with a comparison, a gray bar for
// the previous period beside each. Stack by a second dimension draws stacked bars (no
// comparison). Clicking a bar drills into that value (the widget splits to show it over time);
// right-click offers drill / dashboard filter / inspect / explorer. The picked bar stays bright.
import { useRef } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { toNumber } from '../../lib/metricSeries';
import { categories, formatMetric, opt, separateCharts, sortCategories, type MetricFormat } from '../dashboardModel';
import { AXIS_TICK, exportSeries, GRID, Legend, PREVIOUS, seriesColor, TooltipBox } from './chartTheme';

interface Props {
  widget: DashboardWidget;
  result: WidgetResultDto;
  labels: Map<string, string>;
  height: number;
  format: MetricFormat;
  /** click a bar: drill into it */
  onPick: ((value: string) => void) | null;
  /** right-click a bar: the value menu at the pointer */
  onMenu: ((value: string, x: number, y: number) => void) | null;
  /** the drilled value (others are dimmed) */
  selected: string | null;
}

interface BarSeries {
  key: string;
  label: string;
  color: string;
}

interface Shaped {
  rows: Record<string, unknown>[];
  series: BarSeries[];
  stacked: boolean;
}

function stackedShape(widget: DashboardWidget, result: WidgetResultDto, metric: string, dim: string, stack: string): Shaped {
  const { columns, rows } = result.queries.current;
  const [d, s, m] = [columns.indexOf(dim), columns.indexOf(stack), columns.indexOf(metric)];
  const totals = new Map<string, number>();
  const stacks = new Map<string, number>();
  for (const r of rows) {
    const v = Math.abs(toNumber(r[m]) ?? 0);
    totals.set(String(r[d] ?? '∅'), (totals.get(String(r[d] ?? '∅')) ?? 0) + v);
    stacks.set(String(r[s] ?? '∅'), (stacks.get(String(r[s] ?? '∅')) ?? 0) + v);
  }
  const cats = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, opt(widget, 'top_n', 10)).map(([k]) => k);
  const keys = [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const series = keys.map((k, i) => ({ key: `s${i}`, label: k, color: seriesColor(i) }));
  const out = cats.map((c) => ({ x: c, ...Object.fromEntries(series.map((ser) => [ser.key, null])) } as Record<string, unknown>));
  for (const r of rows) {
    const row = out.find((o) => o.x === String(r[d] ?? '∅'));
    const ser = series[keys.indexOf(String(r[s] ?? '∅'))];
    if (row && ser) row[ser.key] = toNumber(r[m]);
  }
  return { rows: out, series, stacked: true };
}

function shape(widget: DashboardWidget, result: WidgetResultDto, metrics: string[], labels: Map<string, string>): Shaped {
  const dim = opt(widget, 'dimension', '');
  const stack = opt<string | null>(widget, 'stack_by', null);
  if (stack) return stackedShape(widget, result, metrics[0], dim, stack);
  const prev = result.queries.current_previous;
  const per = metrics.map((m) => categories(result.queries.current, prev?.status === 'ok' ? prev : null, dim, m));
  const order = sortCategories(per[0] ?? [], opt(widget, 'sort', 'value')).slice(0, opt(widget, 'top_n', 10)).map((c) => c.key);
  const series: BarSeries[] = [];
  metrics.forEach((m, i) => {
    const label = labels.get(m) ?? m;
    series.push({ key: `m${i}`, label, color: seriesColor(widget.metrics!.indexOf(m)) });
    if (prev?.status === 'ok') series.push({ key: `p${i}`, label: `${label} (previous)`, color: PREVIOUS });
  });
  const rows = order.map((k) => {
    const row: Record<string, unknown> = { x: k };
    per.forEach((cats, i) => {
      const c = cats.find((x) => x.key === k);
      row[`m${i}`] = c?.value ?? null;
      if (prev?.status === 'ok') row[`p${i}`] = c?.previous ?? null;
    });
    return row;
  });
  return { rows, series, stacked: false };
}

function Chart({ data, height, horizontal, format, onPick, onMenu, selected }: {
  data: Shaped; height: number; horizontal: boolean; format: MetricFormat;
  onPick: Props['onPick']; onMenu: Props['onMenu']; selected: string | null;
}) {
  // The chart reports the category under the pointer from mouse movement; keep the last one for
  // a click or right-click whose own report comes without it
  const hovered = useRef<string | null>(null);
  const label = (s: { activeLabel?: unknown } | null | undefined) => (s?.activeLabel == null ? hovered.current : String(s.activeLabel));
  const valueAxis = { tick: AXIS_TICK, tickFormatter: (v: number) => formatMetric(v, format, true), stroke: GRID };
  const catAxis = { dataKey: 'x', type: 'category' as const, tick: AXIS_TICK, stroke: GRID,
    tickFormatter: (v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v) };
  return (
    <div className="flex flex-col gap-1 min-w-0" data-export-series={exportSeries('category', data.rows.map((r) => String(r.x)),
      data.series.map((s) => ({ label: s.label, color: s.color, values: data.rows.map((r) => (r[s.key] as number | null) ?? null) })))}>
      <Legend items={data.series.map((s) => ({ label: s.label, color: s.color, faded: s.color === PREVIOUS }))} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data.rows} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          barGap={1} barCategoryGap="20%" style={{ cursor: onPick ? 'pointer' : undefined }}
          onMouseMove={(s) => { if (s?.activeLabel != null) hovered.current = String(s.activeLabel); }}
          onMouseLeave={() => { hovered.current = null; }}
          onClick={(s) => { const v = label(s); if (v !== null) onPick?.(v); }}
          onContextMenu={(s, e) => { const v = label(s); if (v === null || !onMenu) return; e.preventDefault(); onMenu(v, e.clientX, e.clientY); }}>
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke={GRID} />
          {horizontal ? <XAxis type="number" {...valueAxis} /> : <XAxis {...catAxis} interval="preserveStartEnd" />}
          {horizontal ? <YAxis {...catAxis} width={96} /> : <YAxis {...valueAxis} width={52} />}
          <Tooltip isAnimationActive={false} cursor={{ fill: 'rgb(var(--text-muted) / 0.15)' }}
            content={({ active, label }) => {
              const row = data.rows.find((r) => r.x === label);
              if (!active || !row) return null;
              return <TooltipBox title={String(label)} format={format}
                rows={data.series.map((s) => ({ label: s.label, color: s.color, value: (row[s.key] as number | null) ?? null }))} />;
            }} />
          {data.series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} fillOpacity={s.color === PREVIOUS ? 0.55 : 1}
              stackId={data.stacked ? 'stack' : undefined} maxBarSize={36} isAnimationActive={false}
              radius={data.stacked ? 0 : horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]}>
              {selected !== null && data.rows.map((r) => (
                <Cell key={String(r.x)} fillOpacity={String(r.x) === selected ? (s.color === PREVIOUS ? 0.55 : 1) : 0.25} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BarWidget({ widget, result, labels, height, format, onPick, onMenu, selected }: Props) {
  const metrics = widget.metrics ?? [];
  const dimension = opt(widget, 'dimension', '');
  const horizontal = opt<string>(widget, 'orientation', 'vertical') === 'horizontal';
  const maxima = metrics.map((m) => Math.max(0, ...categories(result.queries.current, null, dimension, m).map((c) => Math.abs(c.value ?? 0))));
  const separate = !opt(widget, 'stack_by', null) && separateCharts(maxima, opt(widget, 'layout', 'auto'));
  if (!separate) {
    const data = shape(widget, result, metrics, labels);
    if (!data.rows.length) return <p className="flex items-center justify-center h-full text-xs text-gray-500">No rows for this period.</p>;
    return <Chart data={data} height={height - (data.series.length > 1 ? 16 : 0)} horizontal={horizontal} format={format}
      onPick={onPick} onMenu={onMenu} selected={selected} />;
  }
  const each = Math.max(56, Math.floor(height / metrics.length) - 30);
  return (
    <div className="flex flex-col gap-2 h-full overflow-hidden">
      {metrics.map((m) => (
        <div key={m} className="min-w-0">
          <span className="text-[10px] text-gray-400">{labels.get(m) ?? m}</span>
          <Chart data={shape(widget, result, [m], labels)} height={each} horizontal={horizontal} format={format}
            onPick={onPick} onMenu={onMenu} selected={selected} />
        </div>
      ))}
    </div>
  );
}
