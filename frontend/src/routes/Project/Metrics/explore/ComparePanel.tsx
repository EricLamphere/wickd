// Compare mode (plan 14, Pro) under the explorer's widget: its query run two ways — uncommitted
// changes vs HEAD, this branch vs its base (merge base), two targets, two metrics — with what
// moved, both sides on one chart, the differences and the two SQLs diffed. It runs when compare
// is switched on or its mode / base changes; Run again after changing the widget.
import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { GitCompare, Loader2, Play, X } from 'lucide-react';
import { CartesianGrid, Bar, BarChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DataTable } from '../../../../components/DataTable';
import { api } from '../../../../lib/api';
import { semanticApi, type CompareResultDto, type MetricQueryBody, type SemanticCatalogDto } from '../../../../lib/semanticApi';
import { useTheme } from '../../../../lib/useTheme';
import { errorText } from '../dashboards/useDashboards';
import { formatChange, formatMetric } from '../dashboards/dashboardModel';
import { AXIS_TICK, GRID, PREVIOUS, seriesColor, TooltipBox } from '../dashboards/widgets/chartTheme';
import { compareFields, compareSeries, differencesTable, MODE_LABELS, COMPARE_MODES, sideLabel, sideNames, type CompareState } from '../lib/compareView';
import { formatTime } from '../lib/metricSeries';

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  /** the widget's main query (null until it has one) */
  query: MetricQueryBody | null;
  grain: string;
  state: CompareState;
  onChange: (next: CompareState | null) => void;
}

const FIELD = 'px-2 py-1 text-xs rounded border border-gray-700 bg-surface-app text-gray-200';
const CHART_PX = 220;

function CompareChart({ result, metric, labels, grain }: { result: CompareResultDto; metric: string; labels: Map<string, string>; grain: string }) {
  const names = sideNames(result, labels);
  const label = labels.get(metric) ?? metric;
  // comparing metrics, each line is a metric; otherwise the metric now and before
  const currentName = result.mode === 'metrics' ? names.current : `${label}, now`;
  const baseName = result.mode === 'metrics' ? names.base : `${label}, before`;
  const { time, points } = compareSeries(result, metric);
  const now = seriesColor(0);
  const tick = (v: unknown) => (time && typeof v === 'number' ? formatTime(v, grain) : String(v));
  const tooltip = ({ active, label: x }: { active?: boolean; label?: unknown }) => {
    const p = points.find((pt) => pt.x === x);
    if (!active || !p) return null;
    const pct = p.current !== null && p.base ? (p.current - p.base) / Math.abs(p.base) : null;
    return <TooltipBox title={`${tick(x)}${pct !== null ? ` · ${formatChange(pct)}` : ''}`} format={{}}
      rows={[{ label: currentName, color: now, value: p.current }, { label: baseName, color: PREVIOUS, value: p.base, dashed: true }]} />;
  };
  const yAxis = <YAxis tick={AXIS_TICK} tickFormatter={(v: number) => formatMetric(v, {}, true)} stroke={GRID} width={52} />;
  return (
    <ResponsiveContainer width="100%" height={CHART_PX}>
      {time ? (
        <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={AXIS_TICK} tickFormatter={tick} stroke={GRID} minTickGap={28} />
          {yAxis}
          <Tooltip isAnimationActive={false} content={tooltip} />
          <Line dataKey="base" stroke={PREVIOUS} strokeOpacity={0.7} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="current" stroke={now} strokeWidth={2} dot={points.length < 3} isAnimationActive={false} connectNulls={false} />
        </LineChart>
      ) : (
        <BarChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barGap={1}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="x" tick={AXIS_TICK} stroke={GRID} interval="preserveStartEnd" />
          {yAxis}
          <Tooltip isAnimationActive={false} content={tooltip} cursor={{ fill: 'rgb(var(--text-muted) / 0.15)' }} />
          <Bar dataKey="current" fill={now} maxBarSize={32} isAnimationActive={false} />
          <Bar dataKey="base" fill={PREVIOUS} fillOpacity={0.55} maxBarSize={32} isAnimationActive={false} />
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}

export function ComparePanel({ projectId, catalog, labels, query, grain, state, onChange }: Props) {
  const theme = useTheme();
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [showSql, setShowSql] = useState(false);
  const options = useQuery({ queryKey: ['compare-options', projectId], queryFn: () => semanticApi.compareOptions(projectId) });
  const targets = useQuery({ queryKey: ['dbt-targets', projectId], queryFn: () => api.profiles.dbtTargets(projectId), enabled: state.mode === 'targets' });
  const run = useMutation({ mutationFn: (body: Parameters<typeof semanticApi.compare>[1]) => semanticApi.compare(projectId, body) });
  const key = query ? JSON.stringify({ query, ...state }) : null;
  const [ranKey, setRanKey] = useState<string | null>(null);
  const start = () => {
    if (!query || !key) return;
    setRanKey(key);
    run.mutate({ query, mode: state.mode, ...compareFields(state) });
  };
  // a new mode or base runs it; widget edits only mark it out of date (each compare is two dbt shows)
  const startRef = useRef(start);
  startRef.current = start;
  const modeKey = `${state.mode}:${state.base}`;
  const hasQuery = !!query;
  useEffect(() => { if (hasQuery) startRef.current(); }, [modeKey, hasQuery]);

  const result = run.data;
  const metric = result?.metrics[0] ?? '';
  const table = useMemo(() => (result ? differencesTable(result, labels, onlyChanged) : null), [result, labels, onlyChanged]);
  const stale = !!result && ranKey !== key;
  const otherMetrics = catalog.metrics.filter((m) => !query?.metrics?.includes(m.name));

  const basePicker = state.mode === 'branch' ? (
    <input value={state.base} onChange={(e) => onChange({ ...state, base: e.target.value })} placeholder={options.data?.branch_base ?? 'main'}
      aria-label="Base branch" className={`${FIELD} w-36 font-mono`} />
  ) : state.mode === 'targets' ? (
    <select value={state.base || options.data?.base_target || ''} onChange={(e) => onChange({ ...state, base: e.target.value })}
      aria-label="Target to compare with" className={FIELD}>
      <option value="">Pick a target…</option>
      {(targets.data?.targets ?? []).filter((t) => t !== options.data?.active_target).map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  ) : state.mode === 'metrics' ? (
    <select value={state.base} onChange={(e) => onChange({ ...state, base: e.target.value })} aria-label="Metric to compare with" className={FIELD}>
      <option value="">Pick a metric…</option>
      {otherMetrics.map((m) => <option key={m.name} value={m.name}>{m.label || m.name}</option>)}
    </select>
  ) : null;

  return (
    <section className="flex flex-col gap-3 p-3 rounded border border-brand-900/60 bg-surface-panel" aria-label="Compare">
      <div className="flex flex-wrap items-center gap-2">
        <GitCompare className="w-4 h-4 text-brand-300" />
        <select value={state.mode} onChange={(e) => onChange({ mode: e.target.value as CompareState['mode'], base: '' })} aria-label="Compare mode" className={FIELD}>
          {COMPARE_MODES.map((m) => <option key={m} value={m} disabled={(m === 'working' || m === 'branch') && options.data?.is_repo === false}>{MODE_LABELS[m]}</option>)}
        </select>
        {basePicker}
        <button onClick={start} disabled={!query || run.isPending || (state.mode === 'metrics' && !state.base)}
          className="flex items-center gap-1.5 px-3 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
          {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{run.isPending ? 'Comparing…' : 'Compare'}
        </button>
        {stale && !run.isPending && <span className="text-[11px] text-amber-300">The widget changed since — Compare again.</span>}
        <div className="flex-1" />
        <button onClick={() => onChange(null)} aria-label="Stop comparing" title="Stop comparing" className="text-gray-500 hover:text-gray-200"><X className="w-4 h-4" /></button>
      </div>
      {!query && <p className="text-xs text-gray-500">Pick a metric for the widget first.</p>}
      {run.isPending && (state.mode === 'working' || state.mode === 'branch') && (
        <p className="text-[11px] text-gray-500">The first compare against a commit checks it out and parses it, which takes a few seconds; later ones reuse it.</p>
      )}
      {run.error && <p className="text-xs text-red-300">{errorText(run.error)}</p>}
      {result && (
        <>
          {result.notes.map((n) => <p key={n} className="text-[11px] text-amber-300">{n}</p>)}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-400">
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5" style={{ background: seriesColor(0) }} />{sideLabel(result, 'current', options.data, labels)}</span>
            <span className="flex items-center gap-1.5"><span className="w-3 border-t border-dashed" style={{ borderColor: PREVIOUS }} />{sideLabel(result, 'base', options.data, labels)}</span>
          </div>
          {result.current.error && <p className="text-xs text-red-300">Now: {result.current.error}</p>}
          {result.base.error && <p className={`text-xs ${result.base.missing ? 'text-gray-400' : 'text-red-300'}`}>Before: {result.base.error}</p>}
          {result.diff && (
            <>
              <p className="text-sm text-gray-100">{result.diff.summary.headline}</p>
              {result.diff.summary.by_dimension.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {result.diff.summary.by_dimension.map((d) => (
                    <span key={`${d.dimension}=${String(d.value)}`} title={`${d.changed} of ${d.rows} rows differ`}
                      className="px-1.5 py-0.5 text-[11px] rounded border border-gray-700 bg-surface-app text-gray-300">
                      <span className="text-gray-500">{d.dimension} = </span>{d.value === null ? '∅' : String(d.value)}
                      {d.pct !== null && <span className={`ml-1 ${d.pct < 0 ? 'text-red-400' : 'text-emerald-400'}`}>{formatChange(d.pct)}</span>}
                    </span>
                  ))}
                </div>
              )}
              <CompareChart result={result} metric={metric} labels={labels} grain={grain} />
              <div className="flex items-center gap-3 text-[11px]">
                <label className="flex items-center gap-1.5 text-gray-400 cursor-pointer">
                  <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />Only rows that differ
                </label>
                <button onClick={() => setShowSql((s) => !s)} className="text-brand-300 hover:text-brand-200">
                  {showSql ? 'Hide' : 'Show'} the SQL diff{result.diff.sql_diff ? '' : ' (same SQL)'}
                </button>
              </div>
              {table && (
                <div className="h-64">
                  {table.rows.length ? <DataTable className="h-full" columns={table.columns.map((c, i) => ({ key: c, align: i >= result.diff!.key_columns.length && c !== 'status' ? 'right' as const : undefined }))} rows={table.rows} />
                    : <p className="text-xs text-gray-500">No rows differ.</p>}
                </div>
              )}
              {showSql && (
                <div className="h-72 rounded border border-gray-800 overflow-hidden">
                  <DiffEditor original={result.base.sql ?? ''} modified={result.current.sql ?? ''} language="sql"
                    theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
                    options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, automaticLayout: true }} />
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
