import { useId, useState } from 'react';
import { areaPath, linePath, median, nearestIndex, plotPoints } from '../../lib/charts';

interface SparklineProps {
  values: number[];
  /** Readout for the hovered value (default: the number itself). */
  format?: (value: number) => string;
  /** Point labels for the readout, e.g. run dates (same length as values). */
  labels?: string[];
  width?: number;
  height?: number;
  /** Colour the last point amber when it's this many times the median or more. */
  warnRatio?: number;
}

/** Area sparkline with a dashed median line; hover shows each point's value. */
export function Sparkline({ values, format = String, labels, width = 112, height = 28, warnRatio = 1.5 }: SparklineProps) {
  const gradient = useId();
  const [hover, setHover] = useState<number | null>(null);
  if (values.length < 2) return <span className="text-[11px] text-gray-600">not enough runs</span>;

  const pts = plotPoints(values, width, height, 3);
  const mid = median(values) ?? 0;
  const midY = plotPoints([mid], width, height, 3, Math.max(...values))[0].y;
  const lastIndex = values.length - 1;
  const lastWarn = mid > 0 && values[lastIndex] >= mid * warnRatio;
  const shown = hover ?? lastIndex;

  return (
    <span className="inline-flex items-center gap-2">
      <svg
        width={width}
        height={height}
        className="overflow-visible text-brand-400"
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(nearestIndex(pts, e.clientX - box.left));
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Trend over ${values.length} runs, last ${format(values[lastIndex])}`}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.35} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={areaPath(pts, height)} fill={`url(#${gradient})`} />
        <line x1={0} x2={width} y1={midY} y2={midY} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="2 3" />
        <path d={linePath(pts)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
        {hover !== null && (
          <line x1={pts[hover].x} x2={pts[hover].x} y1={0} y2={height} stroke="currentColor" strokeOpacity={0.3} />
        )}
        <circle
          cx={pts[shown].x}
          cy={pts[shown].y}
          r={2.75}
          className={shown === lastIndex && lastWarn ? 'fill-amber-400' : 'fill-brand-300'}
        />
      </svg>
      <span className={`w-14 text-[11px] tabular-nums ${hover !== null ? 'text-gray-200' : 'text-gray-500'}`}>
        {format(values[shown])}
        {hover !== null && labels?.[hover] && <span className="block text-[10px] text-gray-500">{labels[hover]}</span>}
      </span>
    </span>
  );
}
