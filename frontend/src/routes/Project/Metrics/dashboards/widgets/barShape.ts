// A bar widget's result shaped for Recharts. Plain bars: per metric, a bar per value of the
// dimension (top N, sorted), plus a gray previous-period bar beside each when compared. Stacked
// (one metric per chart): each bar split by the stack dimension's top values, and beside it the
// previous period's bar split the same way in the same colors, faded. Pure; tested in
// barShape.test.ts.
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { toNumber } from '../../lib/metricSeries';
import { categories, opt, sortCategories } from '../dashboardModel';
import { PREVIOUS, seriesColor } from './chartTheme';

export interface BarSeries {
  key: string;
  label: string;
  color: string;
  opacity: number;
  /** a stack's value (stacked bars only) */
  stack?: string;
  previous?: boolean;
  /** bars sharing a stackId are stacked (current / previous) */
  stackId?: string;
}

export interface Shaped {
  rows: Record<string, unknown>[];
  series: BarSeries[];
  legend: { label: string; color: string; faded?: boolean }[];
  stacked: boolean;
}

/** Stack values beyond these are left out (their colors would repeat). */
export const MAX_STACKS = 8;
const PREVIOUS_OPACITY = 0.55;
const PREVIOUS_STACK_OPACITY = 0.35;

const keyOf = (v: unknown) => (v === null || v === undefined ? '∅' : String(v));

function sumBy(rows: unknown[][], key: number, metric: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(keyOf(r[key]), (out.get(keyOf(r[key])) ?? 0) + Math.abs(toNumber(r[metric]) ?? 0));
  return out;
}

const largest = (totals: Map<string, number>, n: number) => [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

export function stackedShape(widget: DashboardWidget, result: WidgetResultDto, metric: string): Shaped {
  const dim = opt(widget, 'dimension', '');
  const stack = opt(widget, 'stack_by', '');
  const cur = result.queries.current;
  const prev = result.queries.current_previous?.status === 'ok' ? result.queries.current_previous : null;
  const [d, s, m] = [cur.columns.indexOf(dim), cur.columns.indexOf(stack), cur.columns.indexOf(metric)];
  // bars by their current totals; with the name sort, in name order
  const totals = sumBy(cur.rows, d, m);
  const top = largest(totals, opt(widget, 'top_n', 10));
  const cats = opt<string>(widget, 'sort', 'value') === 'name'
    ? sortCategories(top.map((key) => ({ key, value: totals.get(key) ?? null, previous: null })), 'name').map((c) => c.key)
    : top;
  const keys = largest(sumBy(cur.rows, s, m), MAX_STACKS);
  const label = (k: string) => (k === '∅' ? '(empty)' : k);
  const series: BarSeries[] = keys.map((k, i) => ({ key: `s${i}`, label: label(k), color: seriesColor(i), opacity: 1, stack: k, stackId: 'current' }));
  if (prev) {
    series.push(...keys.map((k, i) => ({
      key: `p${i}`, label: `${label(k)} (previous)`, color: seriesColor(i), opacity: PREVIOUS_STACK_OPACITY, stack: k, previous: true, stackId: 'previous',
    })));
  }
  const rows = cats.map((c) => ({ x: c, ...Object.fromEntries(series.map((ser) => [ser.key, null])) } as Record<string, unknown>));
  const fill = (q: { columns: string[]; rows: unknown[][] }, prefix: 's' | 'p') => {
    const [qd, qs, qm] = [q.columns.indexOf(dim), q.columns.indexOf(stack), q.columns.indexOf(metric)];
    for (const r of q.rows) {
      const row = rows.find((o) => o.x === keyOf(r[qd]));
      const i = keys.indexOf(keyOf(r[qs]));
      if (row && i >= 0) row[`${prefix}${i}`] = toNumber(r[qm]);
    }
  };
  fill(cur, 's');
  if (prev) fill(prev, 'p');
  const legend = [
    ...series.filter((x) => !x.previous).map((x) => ({ label: x.label, color: x.color })),
    ...(prev ? [{ label: 'Previous period', color: PREVIOUS, faded: true }] : []),
  ];
  return { rows, series, legend, stacked: true };
}

export function groupedShape(widget: DashboardWidget, result: WidgetResultDto, metrics: string[], labels: Map<string, string>): Shaped {
  const dim = opt(widget, 'dimension', '');
  const prev = result.queries.current_previous?.status === 'ok' ? result.queries.current_previous : null;
  const per = metrics.map((m) => categories(result.queries.current, prev, dim, m));
  const order = sortCategories(per[0] ?? [], opt(widget, 'sort', 'value')).slice(0, opt(widget, 'top_n', 10)).map((c) => c.key);
  const series: BarSeries[] = [];
  metrics.forEach((m, i) => {
    const label = labels.get(m) ?? m;
    series.push({ key: `m${i}`, label, color: seriesColor((widget.metrics ?? []).indexOf(m)), opacity: 1 });
    if (prev) series.push({ key: `p${i}`, label: `${label} (previous)`, color: PREVIOUS, opacity: PREVIOUS_OPACITY, previous: true });
  });
  const rows = order.map((k) => {
    const row: Record<string, unknown> = { x: k };
    per.forEach((cats, i) => {
      const c = cats.find((x) => x.key === k);
      row[`m${i}`] = c?.value ?? null;
      if (prev) row[`p${i}`] = c?.previous ?? null;
    });
    return row;
  });
  return { rows, series, legend: series.map((s) => ({ label: s.label, color: s.color, faded: s.previous })), stacked: false };
}

/** `metrics` shaped for one chart (stacked widgets get one chart per metric: pass one). */
export function barShape(widget: DashboardWidget, result: WidgetResultDto, metrics: string[], labels: Map<string, string>): Shaped {
  return opt<string | null>(widget, 'stack_by', null)
    ? stackedShape(widget, result, metrics[0])
    : groupedShape(widget, result, metrics, labels);
}
