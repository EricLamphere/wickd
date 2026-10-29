// Bar chart: one bar per value of the widget's dimension; with a comparison, a gray bar for
// the previous period beside each (shapes in barShape.ts). Stack by a second dimension draws
// stacked bars, the previous period's beside them in the same colors, faded, and one chart per
// metric. Clicking a bar shows that value over time (the widget splits); right-click offers
// show timeseries / dashboard filter / drill into… / explorer. On a stacked bar, a segment
// (current or previous) picks both values (bar and stack) and the space above the bar picks the
// bar's value alone. The picked bar or segment stays bright.
import { useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { categories, formatMetric, opt, separateCharts, type MetricFormat } from '../dashboardModel';
import type { Pick } from '../drill';
import { barShape, type BarSeries, type Shaped } from './barShape';
import { AXIS_TICK, exportSeries, GRID, Legend, PREVIOUS, TooltipBox, type TooltipRow } from './chartTheme';

interface Props {
  widget: DashboardWidget;
  result: WidgetResultDto;
  labels: Map<string, string>;
  height: number;
  format: MetricFormat;
  /** click a bar or segment: show it over time */
  onPick: ((pick: Pick) => void) | null;
  /** right-click a bar or segment: the value menu at the pointer */
  onMenu: ((pick: Pick, x: number, y: number) => void) | null;
  /** the drilled value (others are dimmed) */
  selected: Pick | null;
}

/** Whether the bar `x` (segment `stack`, when stacked) is the picked one. */
function isPicked(selected: Pick | null, dim: string, stackBy: string | null, x: string, stack: string | undefined): boolean {
  if (!selected) return true;
  const value = (d: string) => selected.values.find((v) => v.dimension === d)?.value;
  if (value(dim) !== x) return false;
  const s = stackBy ? value(stackBy) : undefined;
  return s === undefined || s === stack;
}

/** Tooltip rows for a bar: a hovered stack's current and previous values, else every stack plus the previous total. */
function tooltipRows(data: Shaped, row: Record<string, unknown>, segment: BarSeries | undefined): TooltipRow[] {
  const value = (s: BarSeries) => (row[s.key] as number | null) ?? null;
  const toRow = (s: BarSeries): TooltipRow => ({ label: s.label, color: s.color, value: value(s), dashed: s.previous, active: s.key === segment?.key });
  if (!data.stacked) return data.series.map(toRow);
  if (segment) return data.series.filter((s) => s.stack === segment.stack).map(toRow);
  const previous = data.series.filter((s) => s.previous);
  const total = previous.reduce<number | null>((sum, s) => (value(s) === null ? sum : (sum ?? 0) + value(s)!), null);
  return [
    ...data.series.filter((s) => !s.previous && value(s) !== null).map(toRow),
    ...(previous.length ? [{ label: 'Previous period, total', color: PREVIOUS, value: total, dashed: true }] : []),
  ];
}

function Chart({ data, height, horizontal, format, toPick, onPick, onMenu, selected, isBright }: {
  data: Shaped; height: number; horizontal: boolean; format: MetricFormat;
  /** the bar `x`, narrowed to a stacked segment's value when the pointer is on one */
  toPick: (x: string, stack: string | null) => Pick;
  onPick: Props['onPick']; onMenu: Props['onMenu']; selected: Pick | null;
  isBright: (x: string, stack: string | undefined) => boolean;
}) {
  // The chart reports the category under the pointer from mouse movement; keep the last one for
  // a click or right-click whose own report comes without it
  const hovered = useRef<string | null>(null);
  // the stacked segment under the pointer (null above the bar: the whole bar)
  const segment = useRef<BarSeries | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<string | null>(null);
  const setSegment = (s: BarSeries | null) => { segment.current = s; setHoveredSegment(s?.key ?? null); };
  const label = (s: { activeLabel?: unknown } | null | undefined) => (s?.activeLabel == null ? hovered.current : String(s.activeLabel));
  const pickAt = (s: { activeLabel?: unknown } | null | undefined) => {
    const x = label(s);
    return x === null ? null : toPick(x, segment.current?.stack ?? null);
  };
  const valueAxis = { tick: AXIS_TICK, tickFormatter: (v: number) => formatMetric(v, format, true), stroke: GRID };
  const catAxis = { dataKey: 'x', type: 'category' as const, tick: AXIS_TICK, stroke: GRID,
    tickFormatter: (v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v) };
  const interactive = !!(onPick || onMenu);
  return (
    <div className="flex flex-col gap-1 min-w-0" data-export-series={exportSeries('category', data.rows.map((r) => String(r.x)),
      data.series.map((s) => ({ label: s.label, color: s.color, values: data.rows.map((r) => (r[s.key] as number | null) ?? null) })))}>
      <Legend items={data.legend} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data.rows} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          barGap={1} barCategoryGap="20%" style={{ cursor: onPick ? 'pointer' : undefined }}
          onMouseMove={(s) => { if (s?.activeLabel != null) hovered.current = String(s.activeLabel); }}
          onMouseLeave={() => { hovered.current = null; setSegment(null); }}
          onClick={(s) => { const p = pickAt(s); if (p) onPick?.(p); }}
          onContextMenu={(s, e) => { const p = pickAt(s); if (!p || !onMenu) return; e.preventDefault(); onMenu(p, e.clientX, e.clientY); }}>
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke={GRID} />
          {horizontal ? <XAxis type="number" {...valueAxis} /> : <XAxis {...catAxis} interval="preserveStartEnd" />}
          {horizontal ? <YAxis {...catAxis} width={96} /> : <YAxis {...valueAxis} width={52} />}
          <Tooltip isAnimationActive={false} cursor={{ fill: 'rgb(var(--text-muted) / 0.15)' }}
            content={({ active, label }) => {
              const row = data.rows.find((r) => r.x === label);
              if (!active || !row) return null;
              const seg = data.stacked ? data.series.find((s) => s.key === hoveredSegment) : undefined;
              const stackLabel = seg?.stack === '∅' ? '(empty)' : seg?.stack;
              const hint = !data.stacked || !interactive ? undefined
                : seg ? `Click or right-click: ${label} · ${stackLabel}` : `Right-click: all of ${label}`;
              return <TooltipBox title={seg ? `${label} · ${stackLabel}` : String(label)} format={format} rows={tooltipRows(data, row, seg)} hint={hint} />;
            }} />
          {data.series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} fillOpacity={s.opacity}
              stackId={s.stackId} maxBarSize={36} isAnimationActive={false}
              radius={data.stacked ? 0 : horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]}
              {...(data.stacked && interactive ? { onMouseEnter: () => setSegment(s), onMouseLeave: () => setSegment(null) } : {})}>
              {(selected !== null || (data.stacked && hoveredSegment !== null)) && data.rows.map((r) => {
                const x = String(r.x);
                const bright = selected !== null ? isBright(x, s.stack) : true;
                // the hovered stack (current and previous) stands out from the rest of its bars
                const hoveredStack = data.series.find((h) => h.key === hoveredSegment)?.stack;
                const dim = data.stacked && hoveredSegment !== null && hovered.current === x && hoveredStack !== s.stack;
                return <Cell key={x} fillOpacity={bright ? s.opacity * (dim ? 0.6 : 1) : s.opacity * 0.3} />;
              })}
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
  const stackBy = opt<string | null>(widget, 'stack_by', null);
  const toPick = (x: string, stack: string | null): Pick => ({
    values: [{ dimension, value: x }, ...(stackBy && stack !== null ? [{ dimension: stackBy, value: stack }] : [])],
  });
  const isBright = (x: string, stack: string | undefined) => isPicked(selected, dimension, stackBy, x, stack);
  const chartProps = { horizontal: opt<string>(widget, 'orientation', 'vertical') === 'horizontal', format, toPick, onPick, onMenu, selected, isBright };
  const maxima = metrics.map((m) => Math.max(0, ...categories(result.queries.current, null, dimension, m).map((c) => Math.abs(c.value ?? 0))));
  // stacked: one chart per metric (several metrics' stacks side by side would share colors)
  const separate = stackBy ? metrics.length > 1 : separateCharts(maxima, opt(widget, 'layout', 'auto'));
  if (!separate) {
    const data = barShape(widget, result, metrics, labels);
    if (!data.rows.length) return <p className="flex items-center justify-center h-full text-xs text-gray-500">No rows for this period.</p>;
    return <Chart data={data} height={height - (data.legend.length > 1 ? 16 : 0)} {...chartProps} />;
  }
  const each = Math.max(56, Math.floor(height / metrics.length) - 30);
  return (
    <div className="flex flex-col gap-2 h-full overflow-hidden">
      {metrics.map((m) => (
        <div key={m} className="min-w-0">
          <span className="text-[10px] text-gray-400">{labels.get(m) ?? m}</span>
          <Chart data={barShape(widget, result, [m], labels)} height={each} {...chartProps} />
        </div>
      ))}
    </div>
  );
}
