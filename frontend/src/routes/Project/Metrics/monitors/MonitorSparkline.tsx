// A monitor card's sparkline: the value line over its expected band, flagged periods
// marked (red alarms, amber warnings), the partial period hollow. Hover reads a point.
import { useState } from 'react';
import type { MonitorPointDto } from '../../../../lib/monitorsApi';
import { clampBand, formatNumber, KIND_LABEL, kindTone, sparkGeometry } from './monitorView';

const MARKER: Record<string, string> = { fail: 'rgb(var(--red-500))', warn: 'rgb(var(--amber-500))' };

export function MonitorSparkline({ points, width = 240, height = 48 }: { points: MonitorPointDto[]; width?: number; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const geometry = sparkGeometry(clampBand(points), width, height, 4);
  if (!geometry.line) return <div style={{ height }} className="flex items-center text-[11px] text-gray-600">No data yet</div>;

  const step = points.length > 1 ? (width - 8) / (points.length - 1) : 0;
  const shown = hover !== null ? points[hover] : null;

  return (
    <div className="relative">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Recent values against the expected range"
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - box.left) / box.width) * width;
          setHover(step ? Math.max(0, Math.min(points.length - 1, Math.round((x - 4) / step))) : 0);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <path d={geometry.band} style={{ fill: 'var(--series-1)', fillOpacity: 0.15 }} />
        <path d={geometry.line} fill="none" style={{ stroke: 'var(--series-1)' }} strokeWidth={1.5}
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover !== null && <line x1={4 + hover * step} x2={4 + hover * step} y1={0} y2={height}
          stroke="rgb(var(--text-muted))" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        {geometry.flagged.map((f, i) => (
          <circle key={i} cx={f.x} cy={f.y} r={3} fill={MARKER[kindTone(f.kind)] ?? MARKER.warn}
            stroke="rgb(var(--bg-surface-panel))" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ))}
        {geometry.partial && <circle cx={geometry.partial.x} cy={geometry.partial.y} r={2.5} fill="rgb(var(--bg-surface-panel))"
          style={{ stroke: 'var(--series-1)' }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
      {shown && (
        <div className="absolute -top-1 right-0 -translate-y-full px-2 py-1 bg-surface-elevated border border-gray-700 rounded shadow text-[10px] text-gray-300 whitespace-nowrap pointer-events-none">
          <span className="text-gray-500">{shown.period}{shown.partial ? ' (so far)' : ''}</span>{' '}
          <span className="font-mono text-gray-100">{formatNumber(shown.value)}</span>
          {shown.expected !== null && <span className="text-gray-500"> · ~{formatNumber(shown.expected)} expected</span>}
          {shown.kind !== 'none' && <span className={kindTone(shown.kind) === 'fail' ? ' text-red-300' : ' text-amber-300'}> · {KIND_LABEL[shown.kind]}</span>}
        </div>
      )}
    </div>
  );
}
