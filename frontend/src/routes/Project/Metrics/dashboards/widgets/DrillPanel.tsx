// The drill-down inside a widget: its metrics over time for the picked value (current period,
// previous dashed gray), under the original chart. Not saved to the file.
import { Filter, Loader2, X } from 'lucide-react';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { semanticErrorBody } from '../../../../../lib/semanticApi';
import { drillResult, pickLabel, type Pick } from '../drill';
import type { MetricFormat } from '../dashboardModel';
import { TimeseriesWidget } from './TimeseriesWidget';
import { useDrill } from './useDrill';

interface Props {
  projectId: number;
  widget: DashboardWidget;
  result: WidgetResultDto;
  pick: Pick;
  labels: Map<string, string>;
  format: MetricFormat;
  height: number;
  onClose: () => void;
  onApplyFilter: (pick: Pick) => void;
}

export function DrillPanel({ projectId, widget, result, pick, labels, format, height, onClose, onApplyFilter }: Props) {
  const drill = useDrill(projectId, result, pick);
  const metrics = (result.queries.current?.query.metrics ?? widget.metrics ?? []) as string[];
  const series: DashboardWidget = { id: `${widget.id}-drill`, type: 'timeseries', width: 100, height, metrics, options: { style: 'line' } };
  const error = drill.error ? (semanticErrorBody(drill.error)?.message ?? String(drill.error)) : null;
  return (
    <div className="flex flex-col min-w-0 min-h-0 h-full" data-drill="">
      <div className="flex items-center gap-1.5 shrink-0 mb-1">
        <span className="min-w-0 px-1.5 py-0.5 text-[10px] rounded border border-brand-800 bg-brand-950/40 text-brand-200 truncate"
          title={pick.values.map((v) => `${v.dimension} = ${v.value}`).join(', ')}>
          {pickLabel(pick)}
        </span>
        <span className="text-[10px] text-gray-500 shrink-0">over time</span>
        <div className="flex-1" />
        <button onClick={(e) => { e.stopPropagation(); onApplyFilter(pick); }} title="Apply as dashboard filter" aria-label="Apply as dashboard filter"
          className="p-0.5 text-gray-500 hover:text-gray-200" data-export-hide=""><Filter className="w-3.5 h-3.5" /></button>
        <button onClick={(e) => { e.stopPropagation(); onClose(); }} title="Close the drill-down" aria-label="Close the drill-down"
          className="p-0.5 text-gray-500 hover:text-gray-200" data-export-hide=""><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="flex-1 min-h-0">
        {drill.isLoading ? (
          <p className="flex items-center justify-center gap-1.5 h-full text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" />Running…</p>
        ) : error ? (
          <p className="flex items-center justify-center h-full px-2 text-center text-xs text-red-300">{error}</p>
        ) : drill.data ? (
          <TimeseriesWidget widget={series} labels={labels} height={Math.max(60, height - 24)} format={format}
            result={drillResult(result, drill.data.current, drill.data.previous)} />
        ) : null}
      </div>
    </div>
  );
}
