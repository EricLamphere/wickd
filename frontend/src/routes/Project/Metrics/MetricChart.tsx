// Charts for metric results (Recharts, SVG). Colours are CSS variables, so both themes
// follow the app: series from --series-N (styles.css), ink from the text tokens.
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatTime, formatValue, isIsolated, type ChartPanel } from './lib/metricSeries';

const AXIS_TICK = { fill: 'rgb(var(--text-secondary))', fontSize: 11 };
const GRID = 'rgb(var(--border-default))';
const SURFACE = 'rgb(var(--bg-surface-panel))';
const HEIGHT = 240;

interface TooltipEntry {
  dataKey?: string | number;
  value?: number | string | null;
}

function ChartTooltip({ active, payload, label, panel, grain }: {
  active?: boolean; payload?: TooltipEntry[]; label?: string | number; panel: ChartPanel; grain: string;
}) {
  if (!active || !payload?.length) return null;
  const values = new Map(payload.map((p) => [String(p.dataKey), p.value]));
  const title = panel.kind === 'line' ? formatTime(Number(label), grain) : String(label);
  return (
    <div className="min-w-[10rem] px-2.5 py-2 bg-surface-elevated border border-gray-700 rounded shadow-lg text-[11px]">
      <p className="mb-1 text-gray-300 font-medium">{title}</p>
      {panel.series.map((s) => (
        <p key={s.key} className="flex items-center gap-2 text-gray-400">
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
          <span className="flex-1 truncate">{s.label}</span>
          <span className="font-mono text-gray-200 tabular-nums">{formatValue(values.get(s.key) as number | null, false)}</span>
        </p>
      ))}
    </div>
  );
}

function Legend({ panel }: { panel: ChartPanel }) {
  if (panel.series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400">
      {panel.series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 max-w-[14rem]">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
          <span className="truncate">{s.label}</span>
        </span>
      ))}
    </div>
  );
}

interface DotProps {
  cx?: number;
  cy?: number;
  index?: number;
}

/** A dot only where a line can't be seen: a value between gaps (or a 1–2 point series). */
function gapDot(panel: ChartPanel, key: string, color: string) {
  const sparse = panel.data.length < 3;
  return ({ cx, cy, index = 0 }: DotProps) => (
    (sparse || isIsolated(panel.data, key, index)) && cx != null && cy != null
      ? <circle key={`${key}-${index}`} cx={cx} cy={cy} r={4} fill={color} stroke={SURFACE} strokeWidth={2} />
      : <g key={`${key}-${index}`} />
  );
}

function LinePanel({ panel, grain }: { panel: ChartPanel; grain: string }) {
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <LineChart data={panel.data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={AXIS_TICK}
          tickFormatter={(v: number) => formatTime(v, grain)} stroke={GRID} minTickGap={24} />
        <YAxis tick={AXIS_TICK} tickFormatter={(v: number) => formatValue(v)} stroke={GRID} width={56} />
        <Tooltip content={(props) => <ChartTooltip {...(props as object)} panel={panel} grain={grain} />}
          cursor={{ stroke: 'rgb(var(--text-muted))', strokeWidth: 1 }} isAnimationActive={false} />
        {panel.series.map((s) => (
          <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
            dot={gapDot(panel, s.key, s.color)}
            activeDot={{ r: 4, fill: s.color, stroke: SURFACE, strokeWidth: 2 }}
            connectNulls={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function BarPanel({ panel }: { panel: ChartPanel }) {
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <BarChart data={panel.data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="20%">
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="x" type="category" tick={AXIS_TICK} stroke={GRID} interval="preserveStartEnd"
          tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} />
        <YAxis tick={AXIS_TICK} tickFormatter={(v: number) => formatValue(v)} stroke={GRID} width={56} />
        <Tooltip content={(props) => <ChartTooltip {...(props as object)} panel={panel} grain="day" />}
          cursor={{ fill: 'rgb(var(--text-muted) / 0.15)' }} isAnimationActive={false} />
        {panel.series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={48}
            stroke={SURFACE} strokeWidth={1} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function KpiTile({ panel }: { panel: ChartPanel }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 bg-surface-panel border border-gray-800 rounded">
      <span className="text-[11px] text-gray-400 truncate">{panel.label}</span>
      <span className="text-2xl font-semibold text-gray-100 tabular-nums">{formatValue(panel.value ?? null, false)}</span>
    </div>
  );
}

function hiddenNote(panel: ChartPanel): string | null {
  const parts = [
    panel.hiddenSeries ? `${panel.hiddenSeries} more value${panel.hiddenSeries === 1 ? '' : 's'} not drawn` : '',
    panel.hiddenCategories ? `${panel.hiddenCategories} more categor${panel.hiddenCategories === 1 ? 'y' : 'ies'} not drawn` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} — see the Table tab, or add a filter.` : null;
}

/** Small multiples: one chart per metric (each on its own scale), KPIs as tiles. */
export function MetricPanels({ panels, grain }: { panels: ChartPanel[]; grain: string }) {
  const kpis = panels.filter((p) => p.kind === 'kpi');
  const charts = panels.filter((p) => p.kind !== 'kpi');
  return (
    <div className="flex flex-col gap-4">
      {kpis.length > 0 && (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
          {kpis.map((p) => <KpiTile key={p.metric} panel={p} />)}
        </div>
      )}
      <div className={`grid gap-4 ${charts.length > 1 ? 'xl:grid-cols-2' : ''}`}>
        {charts.map((p) => (
          <figure key={p.metric} className="flex flex-col gap-2 min-w-0 px-3 py-2.5 bg-surface-panel border border-gray-800 rounded">
            <figcaption className="text-xs font-medium text-gray-200 truncate">{p.label}</figcaption>
            <Legend panel={p} />
            {p.data.length === 0 ? (
              <p className="py-10 text-center text-xs text-gray-500">No rows to chart.</p>
            ) : p.kind === 'line' ? <LinePanel panel={p} grain={grain} /> : <BarPanel panel={p} />}
            {hiddenNote(p) && <p className="text-[11px] text-gray-500">{hiddenNote(p)}</p>}
          </figure>
        ))}
      </div>
    </div>
  );
}
