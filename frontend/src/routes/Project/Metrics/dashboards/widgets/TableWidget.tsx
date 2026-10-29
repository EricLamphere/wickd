// Table: the widget's metrics by its dimensions; with comparison columns, each metric gets
// "previous" and "change" columns (rows matched by their dimension values). Right-click a row
// for drill / dashboard filter / inspect / explorer on its dimension values.
import { DataTable } from '../../../../../components/DataTable';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { toNumber } from '../../lib/metricSeries';
import { changeRatio, formatChange, opt } from '../dashboardModel';
import type { Pick } from '../drill';

/** Warehouse floats (13692.939999999971) to 2 decimals; still numbers, so copy stays numeric. */
const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

export function tableData(widget: DashboardWidget, result: WidgetResultDto, labels: Map<string, string>): { columns: string[]; rows: unknown[][] } {
  const dims: string[] = opt(widget, 'dimensions', []);
  const metrics = widget.metrics ?? [];
  const cur = result.queries.current;
  const prev = result.queries.current_previous;
  const compare = prev?.status === 'ok';
  const keyOf = (cols: string[], r: unknown[]) => dims.map((d) => String(r[cols.indexOf(d)] ?? '∅')).join('\u0000');
  const prevByKey = new Map(compare ? prev.rows.map((r) => [keyOf(prev.columns, r), r]) : []);
  const columns = [...dims, ...metrics.flatMap((m) => {
    const label = labels.get(m) ?? m;
    return compare ? [label, `${label} (previous)`, `${label} change`] : [label];
  })];
  const rows = cur.rows.map((r) => {
    const p = prevByKey.get(keyOf(cur.columns, r));
    return [...dims.map((d) => r[cur.columns.indexOf(d)]), ...metrics.flatMap((m) => {
      const value = round(toNumber(r[cur.columns.indexOf(m)]));
      if (!compare) return [value];
      const before = p ? round(toNumber(p[prev.columns.indexOf(m)])) : null;
      return [value, before, formatChange(changeRatio(value, before)) ?? ''];
    })];
  });
  return { columns, rows };
}

export function TableWidget({ widget, result, labels, onMenu }: {
  widget: DashboardWidget; result: WidgetResultDto; labels: Map<string, string>;
  onMenu: ((pick: Pick, x: number, y: number) => void) | null;
}) {
  const data = tableData(widget, result, labels);
  const dims: string[] = opt(widget, 'dimensions', []);
  const rowMenu = onMenu && dims.length
    ? (ri: number, x: number, y: number) => onMenu({ values: dims.map((d, i) => ({ dimension: d, value: String(data.rows[ri][i] ?? '∅') })) }, x, y)
    : undefined;
  return (
    <div className="h-full min-h-0" data-export-table={JSON.stringify({ columns: data.columns, rows: data.rows.slice(0, 200) })}>
      <DataTable columns={data.columns.map((c, i) => ({ key: c, align: i >= opt<string[]>(widget, 'dimensions', []).length ? 'right' as const : undefined }))}
        rows={data.rows} onRowContextMenu={rowMenu} />
    </div>
  );
}
