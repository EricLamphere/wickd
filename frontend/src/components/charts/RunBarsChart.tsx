import { useEffect, useRef, useState } from 'react';
import { median, niceMax } from '../../lib/charts';

export interface RunBar {
  id: string | number;
  value: number | null;
  /** e.g. the run's start date */
  label: string;
  status: string;
}

interface RunBarsChartProps {
  bars: RunBar[];
  format: (value: number) => string;
  height?: number;
  /** Highlight one bar (e.g. the run being looked at). */
  highlightId?: string | number;
}

const STATUS_FILL: Record<string, string> = {
  error: 'fill-red-500/80',
  fail: 'fill-red-500/80',
  warn: 'fill-amber-500/80',
  skipped: 'fill-gray-600',
};
const LEFT = 44;
const BOTTOM = 18;

/** One bar per run, coloured by status, with y ticks, a dashed median and a hover readout. Fills its width. */
export function RunBarsChart({ bars, format, height = 150, highlightId }: RunBarsChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const values = bars.map((b) => b.value ?? 0);
  const top = niceMax(Math.max(...values, 0));
  const mid = median(bars.filter((b) => b.value !== null && b.status !== 'error').map((b) => b.value as number));
  const plotW = Math.max(0, width - LEFT - 4);
  const plotH = height - BOTTOM - 6;
  const slot = bars.length ? plotW / bars.length : 0;
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const y = (v: number) => 6 + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const shown = hover !== null ? bars[hover] : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} className="block" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={LEFT} x2={width - 4} y1={y(t)} y2={y(t)} className="stroke-gray-800" strokeDasharray={t ? '2 4' : undefined} />
              <text x={LEFT - 6} y={y(t) + 3} textAnchor="end" className="fill-gray-500 text-[10px] tabular-nums">{format(t)}</text>
            </g>
          ))}
          {bars.map((bar, i) => {
            const v = bar.value ?? 0;
            const x = LEFT + slot * i + (slot - barW) / 2;
            const fill = STATUS_FILL[bar.status] ?? 'fill-brand-500/80';
            return (
              <g key={bar.id} onMouseEnter={() => setHover(i)}>
                <rect x={LEFT + slot * i} y={6} width={slot} height={plotH} fill="transparent" />
                <rect
                  x={x}
                  y={y(v)}
                  width={barW}
                  height={Math.max(1, 6 + plotH - y(v))}
                  rx={2}
                  className={`${fill} transition-opacity ${hover !== null && hover !== i ? 'opacity-50' : ''} ${
                    bar.id === highlightId ? 'stroke-gray-100' : ''
                  }`}
                />
              </g>
            );
          })}
          {mid !== null && (
            <g>
              <line x1={LEFT} x2={width - 4} y1={y(mid)} y2={y(mid)} className="stroke-gray-300" strokeOpacity={0.6} strokeDasharray="4 3" />
              <text x={width - 6} y={y(mid) - 4} textAnchor="end" className="fill-gray-400 text-[10px]">median {format(mid)}</text>
            </g>
          )}
          {bars.length > 0 && (
            <>
              <text x={LEFT} y={height - 4} className="fill-gray-500 text-[10px]">{bars[0].label}</text>
              <text x={width - 4} y={height - 4} textAnchor="end" className="fill-gray-500 text-[10px]">{bars[bars.length - 1].label}</text>
            </>
          )}
        </svg>
      )}
      {shown && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 px-2 py-1 rounded-md border border-gray-700 bg-surface-elevated shadow-lg text-[11px] whitespace-nowrap"
          style={{ left: Math.min(Math.max(LEFT + slot * hover + slot / 2, 60), width - 60) }}
        >
          <span className="font-medium text-gray-100 tabular-nums">{shown.value === null ? '—' : format(shown.value)}</span>
          <span className="text-gray-500"> · {shown.status} · {shown.label}</span>
        </div>
      )}
    </div>
  );
}
