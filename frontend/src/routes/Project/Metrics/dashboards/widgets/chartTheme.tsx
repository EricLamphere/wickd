// Shared look for dashboard charts (Recharts, the explorer's colours and axes). Colours are
// CSS variables so both themes follow the app; the previous period is always gray.
import type { MetricFormat } from '../dashboardModel';
import { formatMetric } from '../dashboardModel';

export const AXIS_TICK = { fill: 'rgb(var(--text-secondary))', fontSize: 10 };
export const GRID = 'rgb(var(--border-default))';
export const SURFACE = 'rgb(var(--bg-panel))';
export const PREVIOUS = 'rgb(var(--gray-500))';
export const BAND = 'rgb(var(--text-muted) / 0.18)';
export const MARKER = { fail: 'rgb(var(--red-500))', warn: 'rgb(var(--amber-500))' } as const;

export function seriesColor(index: number): string {
  return `var(--series-${(index % 8) + 1})`;
}

export interface TooltipRow {
  label: string;
  color: string;
  value: number | null;
  dashed?: boolean;
  /** the row under the pointer (a stacked segment) */
  active?: boolean;
}

export function TooltipBox({ title, rows, format, hint }: { title: string; rows: TooltipRow[]; format: MetricFormat; hint?: string }) {
  return (
    <div className="min-w-[10rem] max-w-[18rem] px-2 py-1.5 bg-surface-elevated border border-gray-700 rounded shadow-lg text-[11px]">
      <p className="mb-0.5 text-gray-300 font-medium truncate">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className={`flex items-center gap-2 ${r.active ? 'text-gray-100 font-medium' : 'text-gray-400'}`}>
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: r.color, opacity: r.dashed ? 0.6 : 1 }} />
          <span className="flex-1 truncate">{r.label}</span>
          <span className="font-mono text-gray-200 tabular-nums">{formatMetric(r.value, format)}</span>
        </p>
      ))}
      {hint && <p className="mt-1 pt-1 border-t border-gray-800 text-[10px] text-gray-500 truncate">{hint}</p>}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; faded?: boolean }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-gray-400 shrink-0">
      {items.map((s) => (
        <span key={s.label} className="flex items-center gap-1 max-w-[12rem]">
          <span className="w-2.5 h-0.5 rounded-sm shrink-0" style={{ background: s.color, opacity: s.faded ? 0.6 : 1 }} />
          <span className="truncate">{s.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Exported HTML reads this to show hover readouts (see lib/dashboardExport/runtime.ts). */
export function exportSeries(kind: 'time' | 'category', labels: string[], series: { label: string; color: string; values: (number | null)[] }[]): string {
  return JSON.stringify({ kind, labels, series });
}
