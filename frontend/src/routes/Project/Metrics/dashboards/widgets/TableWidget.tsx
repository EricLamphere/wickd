// Table: the widget's metrics by period (optional) and its dimensions (tableData.ts). Right-click
// a row for show timeseries / dashboard filter / drill into… / explorer on its dimension values.
import { DataTable } from '../../../../../components/DataTable';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { opt } from '../dashboardModel';
import type { Pick } from '../drill';
import { tableData } from './tableData';

export function TableWidget({ widget, result, labels, onMenu }: {
  widget: DashboardWidget; result: WidgetResultDto; labels: Map<string, string>;
  onMenu: ((pick: Pick, x: number, y: number) => void) | null;
}) {
  const data = tableData(widget, result, labels);
  const dims: string[] = opt(widget, 'dimensions', []);
  // a row's dimension values come after the period column (periods themselves aren't picked)
  const first = data.byPeriod ? 1 : 0;
  const rowMenu = onMenu && dims.length
    ? (ri: number, x: number, y: number) => onMenu({ values: dims.map((d, i) => ({ dimension: d, value: String(data.rows[ri][first + i] ?? '∅') })) }, x, y)
    : undefined;
  return (
    <div className="h-full min-h-0" data-export-table={JSON.stringify({ columns: data.columns, rows: data.rows.slice(0, 200) })}>
      <DataTable columns={data.columns.map((c, i) => ({ key: c, align: i >= data.keyColumns ? 'right' as const : undefined }))}
        rows={data.rows} onRowContextMenu={rowMenu} className="h-full" />
    </div>
  );
}
