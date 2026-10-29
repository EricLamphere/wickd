// Inspect a value: for each of the widget's metrics, its value, the previous period's, the change
// and its share of what's shown, then the value period by period (current vs previous).
import { useEffect, useMemo } from 'react';
import { ExternalLink, Filter, SplitSquareHorizontal, X } from 'lucide-react';
import { DataTable } from '../../../../../components/DataTable';
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { semanticErrorBody } from '../../../../../lib/semanticApi';
import { formatTime } from '../../lib/metricSeries';
import { alignPrevious, changeTone, formatChange, formatMetric, rangeLabel, series, type MetricFormat } from '../dashboardModel';
import { pickLabel, pickStats, type Pick } from '../drill';
import { useDrill } from './useDrill';
import type { ValueActions } from './ValueMenu';

interface Props {
  projectId: number;
  widget: DashboardWidget;
  result: WidgetResultDto;
  pick: Pick;
  labels: Map<string, string>;
  format: MetricFormat;
  higherIsBetter: boolean;
  actions: Omit<ValueActions, 'onInspect'>;
  onClose: () => void;
}

/** Warehouse floats (744.8900000000001) to 2 decimals; still numbers, so copy stays numeric. */
const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

const TONE = { good: 'text-emerald-400', bad: 'text-red-400', flat: 'text-gray-400' };

export function InspectDialog({ projectId, widget, result, pick, labels, format, higherIsBetter, actions, onClose }: Props) {
  const drill = useDrill(projectId, result, pick);
  const metrics = (result.queries.current?.query.metrics ?? widget.metrics ?? []) as string[];
  const grain = result.grain ?? 'day';

  useEffect(() => {
    // capture phase: the table inside handles keys of its own
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const table = useMemo(() => {
    if (!drill.data) return null;
    const time = `metric_time__${grain}`;
    const { current, previous } = drill.data;
    const columns = ['period', ...metrics.flatMap((m) => {
      const label = labels.get(m) ?? m;
      return previous ? [label, `${label} (previous)`, `${label} change`] : [label];
    })];
    const base = series(current.columns, current.rows, metrics[0], time);
    const rows = base.map((p, i) => [formatTime(p.x, grain), ...metrics.flatMap((m) => {
      const cur = series(current.columns, current.rows, m, time);
      const v = round(cur.find((c) => c.x === p.x)?.v ?? null);
      if (!previous) return [v];
      const before = round(alignPrevious(cur, series(previous.columns, previous.rows, m, time))[i] ?? null);
      return [v, before, formatChange(before === null || v === null || before === 0 ? null : (v - before) / Math.abs(before)) ?? ''];
    })]);
    return { columns, rows };
  }, [drill.data, metrics, labels, grain]);

  const error = drill.error ? (semanticErrorBody(drill.error)?.message ?? String(drill.error)) : null;
  const run = (f: (p: Pick) => void) => () => { onClose(); f(pick); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div role="dialog" aria-label={`Inspect ${pickLabel(pick)}`} onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-full max-w-3xl max-h-[85vh] mx-4 bg-surface-panel border border-gray-700 rounded-lg shadow-2xl">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-800">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-gray-100 truncate">{pickLabel(pick)}</h2>
            <p className="text-[11px] text-gray-500 truncate">
              {pick.values.map((v) => `${v.dimension} = ${v.value}`).join(', ')}
              {result.current ? ` · ${rangeLabel(result.current)}` : ''}{result.previous ? ` vs ${rangeLabel(result.previous)}` : ''}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-5 flex flex-col gap-4">
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, metrics.length))}, minmax(0, 1fr))` }}>
            {metrics.map((m) => {
              const s = pickStats(result, pick, m);
              return (
                <div key={m} className="flex flex-col gap-1 p-3 rounded border border-gray-800 bg-surface-app">
                  <span className="text-[11px] text-gray-400 truncate">{labels.get(m) ?? m}</span>
                  <span className="text-xl font-semibold text-gray-100 tabular-nums">{formatMetric(s?.value, format)}</span>
                  {s?.previous !== null && s?.previous !== undefined && (
                    <span className="text-[11px] text-gray-500">
                      vs {formatMetric(s.previous, format)}
                      {formatChange(s.change) && <span className={`ml-1.5 ${TONE[changeTone(s.change, higherIsBetter)]}`}>{formatChange(s.change)}</span>}
                    </span>
                  )}
                  {s?.share !== null && s?.share !== undefined && (
                    <span className="text-[11px] text-gray-500">{(s.share * 100).toFixed(1)}% of the values shown</span>
                  )}
                </div>
              );
            })}
          </div>
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">By {grain}</h3>
            {drill.isLoading && <p className="text-xs text-gray-500">Running…</p>}
            {error && <p className="text-xs text-red-300">{error}</p>}
            {table && <div className="h-64"><DataTable columns={table.columns.map((c, i) => ({ key: c, align: i ? 'right' as const : undefined }))} rows={table.rows} /></div>}
          </section>
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-5 py-3 border-t border-gray-800">
          <button onClick={run(actions.onOpenInExplorer)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">
            <ExternalLink className="w-3.5 h-3.5" />Open in explorer
          </button>
          <button onClick={run(actions.onApplyFilter)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">
            <Filter className="w-3.5 h-3.5" />Apply as dashboard filter
          </button>
          <button onClick={run(actions.onDrill)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500">
            <SplitSquareHorizontal className="w-3.5 h-3.5" />Drill into it
          </button>
        </div>
      </div>
    </div>
  );
}
