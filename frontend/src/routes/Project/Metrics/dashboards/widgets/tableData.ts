// A table widget's rows: optionally a period column first (oldest first), then its dimensions,
// then each metric with "previous" and "change" columns when comparing. Previous rows are matched
// by their dimension values and, with period rows, by the period's position (the 1st week of the
// current period against the 1st week of the previous one). Pure; tested in tableData.test.ts.
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { formatTime, parseTime, toNumber } from '../../lib/metricSeries';
import { changeRatio, formatChange, opt } from '../dashboardModel';

/** Warehouse floats (13692.939999999971) to 2 decimals; still numbers, so copy stays numeric. */
const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

export interface TableData {
  columns: string[];
  rows: unknown[][];
  /** leading label columns: the period (if any) and the dimensions */
  keyColumns: number;
  /** whether the first column is the period */
  byPeriod: boolean;
}

type Query = { columns: string[]; rows: unknown[][] };

/** Each row's key: the period's position among the query's periods, then its dimension values. */
function rowKeys(q: Query, time: string | null, dims: string[]): string[] {
  const t = time ? q.columns.indexOf(time) : -1;
  const times = t >= 0 ? [...new Set(q.rows.map((r) => parseTime(r[t])).filter((x): x is number => x !== null))].sort((a, b) => a - b) : [];
  return q.rows.map((r) => [
    ...(t >= 0 ? [String(times.indexOf(parseTime(r[t]) ?? NaN))] : []),
    ...dims.map((d) => String(r[q.columns.indexOf(d)] ?? '∅')),
  ].join('\u0000'));
}

export function tableData(widget: DashboardWidget, result: WidgetResultDto, labels: Map<string, string>): TableData {
  const dims: string[] = opt(widget, 'dimensions', []);
  const metrics = widget.metrics ?? [];
  const grain = result.grain ?? 'day';
  const byPeriod = !!opt<string | null>(widget, 'period_grain', null);
  const time = byPeriod ? `metric_time__${grain}` : null;
  const cur = result.queries.current;
  const prev = result.queries.current_previous;
  const compare = prev?.status === 'ok';
  const prevByKey = new Map<string, unknown[]>();
  if (compare) rowKeys(prev, time, dims).forEach((k, i) => prevByKey.set(k, prev.rows[i]));
  const keys = rowKeys(cur, time, dims);
  const t = time ? cur.columns.indexOf(time) : -1;
  const columns = [...(byPeriod ? [grain] : []), ...dims, ...metrics.flatMap((m) => {
    const label = labels.get(m) ?? m;
    return compare ? [label, `${label} (previous)`, `${label} change`] : [label];
  })];
  const rows = cur.rows.map((r, i) => {
    const p = prevByKey.get(keys[i]);
    const ms = t >= 0 ? parseTime(r[t]) : null;
    return [
      ...(byPeriod ? [ms === null ? r[t] ?? null : formatTime(ms, grain)] : []),
      ...dims.map((d) => r[cur.columns.indexOf(d)]),
      ...metrics.flatMap((m) => {
        const value = round(toNumber(r[cur.columns.indexOf(m)]));
        if (!compare) return [value];
        const before = p ? round(toNumber(p[prev.columns.indexOf(m)])) : null;
        return [value, before, formatChange(changeRatio(value, before)) ?? ''];
      }),
    ];
  });
  return { columns, rows, keyColumns: (byPeriod ? 1 : 0) + dims.length, byPeriod };
}
