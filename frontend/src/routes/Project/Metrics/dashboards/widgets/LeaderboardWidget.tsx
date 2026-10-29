// Top N: a dimension's top values for one metric, each with an inline bar (share of the top
// value) and the change vs the previous period. Clicking a row drills into it; right-click offers
// drill / dashboard filter / inspect / explorer.
import type { DashboardWidget, WidgetResultDto } from '../../../../../lib/dashboardsApi';
import { categories, changeRatio, changeTone, formatChange, formatMetric, opt, type MetricFormat } from '../dashboardModel';

const TONE = { good: 'text-emerald-400', bad: 'text-red-400', flat: 'text-gray-500' };

export function LeaderboardWidget({ widget, result, format, higherIsBetter, onPick, onMenu, selected }: {
  widget: DashboardWidget; result: WidgetResultDto; format: MetricFormat; higherIsBetter: boolean;
  onPick: ((value: string) => void) | null;
  onMenu: ((value: string, x: number, y: number) => void) | null;
  selected: string | null;
}) {
  const metric = widget.metrics?.[0] ?? '';
  const dimension = opt(widget, 'dimension', '');
  const prev = result.queries.current_previous;
  const rows = categories(result.queries.current, prev?.status === 'ok' ? prev : null, dimension, metric);
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.value ?? 0)));
  if (!rows.length) return <p className="flex items-center justify-center h-full text-xs text-gray-500">No rows for this period.</p>;
  return (
    <ol className="flex flex-col gap-0.5 h-full overflow-auto" data-export-list="">
      {rows.map((r, i) => {
        const ratio = prev?.status === 'ok' ? changeRatio(r.value, r.previous) : null;
        const change = formatChange(ratio);
        return (
          <li key={r.key}>
            <button type="button" disabled={!onPick} onClick={(e) => { e.stopPropagation(); onPick?.(r.key); }}
              onContextMenu={(e) => { if (!onMenu) return; e.preventDefault(); e.stopPropagation(); onMenu(r.key, e.clientX, e.clientY); }}
              title={onPick ? `Drill into ${r.key} (right-click for more)` : undefined}
              className={`relative flex items-center gap-2 w-full px-1.5 py-1 text-left text-xs rounded hover:bg-gray-800/60 disabled:hover:bg-transparent ${
                selected === null ? '' : selected === r.key ? 'ring-1 ring-brand-600 bg-brand-950/30' : 'opacity-50'}`}>
              <span className="absolute inset-y-0.5 left-0 rounded-sm bg-brand-500/15"
                style={{ width: `${max ? (Math.abs(r.value ?? 0) / max) * 100 : 0}%` }} />
              <span className="relative w-5 text-right text-[10px] text-gray-500 tabular-nums">{i + 1}</span>
              <span className="relative flex-1 min-w-[2.5rem] text-gray-200 truncate" title={r.key}>{r.key}</span>
              <span className="relative shrink-0 font-mono text-gray-100 tabular-nums">{formatMetric(r.value, format, 'short')}</span>
              {prev && (
                <span className={`relative shrink-0 w-10 text-right text-[10px] tabular-nums ${TONE[changeTone(ratio, higherIsBetter)]}`}>
                  {change ?? (r.previous === null ? 'new' : '–')}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
