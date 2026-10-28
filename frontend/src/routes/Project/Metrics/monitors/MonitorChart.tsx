// A monitor's history: the value line over its expected band (low..high), flagged
// periods marked (red alarms, amber warnings, hollow while the period is in progress).
// Hover shows the value, expected range, flag and score.
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MonitorGrain, MonitorPointDto } from '../../../../lib/monitorsApi';
import { formatTime, formatValue } from '../lib/metricSeries';
import { clampBand, formatNumber, KIND_LABEL, kindTone } from './monitorView';

const AXIS_TICK = { fill: 'rgb(var(--text-secondary))', fontSize: 11 };
const GRID = 'rgb(var(--border-default))';
const SURFACE = 'rgb(var(--bg-surface-panel))';
const LINE = 'var(--series-1)';
const MARKER = { fail: 'rgb(var(--red-500))', warn: 'rgb(var(--amber-500))' } as const;

interface Datum {
  x: number;
  value: number | null;
  band: [number, number] | null;
  point: MonitorPointDto;
}

function toData(points: MonitorPointDto[]): Datum[] {
  return clampBand(points).map((p) => ({
    x: Date.parse(`${p.period}T00:00:00Z`),
    value: p.value,
    band: p.low !== null && p.high !== null ? [p.low, p.high] : null,
    point: p,
  }));
}

function ChartTooltip({ active, payload, grain }: { active?: boolean; payload?: { payload?: Datum }[]; grain: MonitorGrain }) {
  const datum = payload?.[0]?.payload;
  if (!active || !datum) return null;
  const p = datum.point;
  const tone = kindTone(p.kind);
  return (
    <div className="min-w-[11rem] px-2.5 py-2 bg-surface-elevated border border-gray-700 rounded shadow-lg text-[11px] text-gray-400">
      <p className="mb-1 text-gray-300 font-medium">{formatTime(datum.x, grain)}{p.partial ? ' (in progress)' : ''}</p>
      <p className="flex justify-between gap-3">Value <span className="font-mono text-gray-100">{formatNumber(p.value)}</span></p>
      {p.expected !== null && <p className="flex justify-between gap-3">Expected <span className="font-mono text-gray-200">~{formatNumber(p.expected)}</span></p>}
      {p.low !== null && p.high !== null && (
        <p className="flex justify-between gap-3">Normal range <span className="font-mono text-gray-300">{formatNumber(p.low)} – {formatNumber(p.high)}</span></p>
      )}
      {p.kind !== 'none' && (
        <p className={`mt-1 font-medium ${tone === 'fail' ? 'text-red-300' : 'text-amber-300'}`}>
          {tone === 'fail' ? '▲ ' : '● '}{KIND_LABEL[p.kind]}
          {typeof p.score === 'number' ? ` · score ${p.score.toFixed(1)}` : ''}
        </p>
      )}
      {p.restated && p.previous !== null && p.previous !== undefined && (
        <p className="text-amber-300/90">was {formatNumber(p.previous)}</p>
      )}
      {p.suppressed && <p className="text-gray-500">Marked as expected</p>}
    </div>
  );
}

interface DotProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: Datum;
}

function FlagDot({ cx, cy, index = 0, payload }: DotProps) {
  const p = payload?.point;
  if (!p || cx == null || cy == null || !Number.isFinite(cy)) return <g key={index} />;
  if (p.partial) return <circle key={index} cx={cx} cy={cy} r={4} fill={SURFACE} stroke={LINE} strokeWidth={2} />;
  if (p.kind === 'none') return <g key={index} />;
  const tone = kindTone(p.kind);
  return <circle key={index} cx={cx} cy={cy} r={5} fill={tone === 'fail' ? MARKER.fail : MARKER.warn} stroke={SURFACE} strokeWidth={2} />;
}

export function MonitorChart({ points, grain, height = 260 }: { points: MonitorPointDto[]; grain: MonitorGrain; height?: number }) {
  const data = toData(points);
  if (data.length === 0) return <p className="py-10 text-center text-xs text-gray-500">No history stored yet.</p>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={AXIS_TICK}
          tickFormatter={(v: number) => formatTime(v, grain)} stroke={GRID} minTickGap={32} />
        <YAxis tick={AXIS_TICK} tickFormatter={(v: number) => formatValue(v)} stroke={GRID} width={56} />
        <Tooltip content={(props) => <ChartTooltip {...(props as object)} grain={grain} />}
          cursor={{ stroke: 'rgb(var(--text-muted))', strokeWidth: 1 }} isAnimationActive={false} />
        <Area dataKey="band" stroke="none" fill={LINE} fillOpacity={0.15} connectNulls={false} isAnimationActive={false}
          activeDot={false} />
        <Line type="linear" dataKey="value" stroke={LINE} strokeWidth={2} dot={FlagDot}
          activeDot={{ r: 4, fill: LINE, stroke: SURFACE, strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
