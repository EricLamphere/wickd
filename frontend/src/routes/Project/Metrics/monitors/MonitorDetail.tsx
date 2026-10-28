// One monitor: the history chart with its expected band, flagged periods (mark as
// expected), restated periods, every stored point, and the monitor's settings.
import { useState } from 'react';
import { ArrowLeft, Check, RotateCcw, Trash2 } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import { confirmDialog } from '../../../../lib/dialogs';
import type { MonitorDto, MonitorPatchBody, MonitorPointDto, MonitorSensitivity } from '../../../../lib/monitorsApi';
import { MonitorChart } from './MonitorChart';
import { clampBand, formatNumber, KIND_LABEL, kindTone, monitorTitle, statusStyle } from './monitorView';
import { errorText, useMonitorSeries } from './useMonitors';

const FIELD_CLS = 'px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';
const POINT_COLUMNS = ['period', 'value', 'expected', 'low', 'high', 'score', 'flag'].map((key) => ({
  key, align: key === 'period' || key === 'flag' ? 'left' as const : 'right' as const,
}));

interface Props {
  projectId: number;
  monitor: MonitorDto;
  targets: string[];
  running: boolean;
  onBack: () => void;
  onUpdate: (body: MonitorPatchBody) => void;
  onDelete: () => void;
  onRefresh: () => void;
  onSuppress: (slice: string, period: string, suppressed: boolean) => void;
}

const round = (v: number | null | undefined) => (typeof v === 'number' ? Number(v.toFixed(2)) : null);

function pointRow(p: MonitorPointDto): unknown[] {
  const flag = p.partial ? 'in progress' : p.suppressed ? 'marked as expected' : KIND_LABEL[p.kind];
  return [p.period, round(p.value), round(p.expected), round(p.low), round(p.high), round(p.score), flag];
}

export function MonitorDetail({ projectId, monitor, targets, running, onBack, onUpdate, onDelete, onRefresh, onSuppress }: Props) {
  const [slice, setSlice] = useState(monitor.latest?.worst_slice ?? (monitor.dimension ? String(monitor.slices[0] ?? '') : ''));
  const series = useMonitorSeries(projectId, monitor.id, slice);
  const data = series.data;
  const style = statusStyle(data?.summary.status, running);
  const flagged = (data?.points ?? []).filter((p) => (p.kind !== 'none' || p.suppressed) && !p.partial).reverse();

  const remove = async () => {
    if (await confirmDialog(`Delete the monitor on ${monitor.metric}? Its stored history goes too.`, { confirmLabel: 'Delete', danger: true })) onDelete();
  };

  return (
    <div className="flex flex-col gap-4 p-5 pb-12 max-w-[72rem] mx-auto w-full">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
          <ArrowLeft className="w-3.5 h-3.5" />Monitors
        </button>
        <h2 className="flex-1 text-sm font-semibold text-gray-100 truncate">{monitorTitle(monitor)}</h2>
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${style.pill}`}>{style.label}</span>
        <button onClick={onRefresh} disabled={running}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500 disabled:opacity-40">
          <RotateCcw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />Check now
        </button>
      </div>

      {monitor.dimension && monitor.slices.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-gray-500 mr-1">{monitor.dimension}</span>
          {monitor.slices.map(String).map((s) => {
            const result = monitor.latest?.slices.find((r) => r.slice === s);
            const chip = statusStyle(result?.status);
            return (
              <button key={s} onClick={() => setSlice(s)} title={result?.headline}
                className={`px-2 py-0.5 rounded border text-[11px] font-mono ${s === slice ? 'ring-1 ring-brand-500 ' : ''}${chip.pill}`}>
                {s}
              </button>
            );
          })}
        </div>
      )}

      <section className="flex flex-col gap-2 px-3 py-2.5 bg-surface-panel border border-gray-800 rounded">
        <p className={`text-xs ${style.text}`}>{data?.summary.headline ?? (series.isLoading ? 'Loading…' : '')}</p>
        {series.error ? <p className="text-xs text-red-400">{errorText(series.error)}</p> : null}
        {monitor.latest?.error && <p className="text-xs text-red-400 break-words">Last refresh failed: {monitor.latest.error}</p>}
        <MonitorChart points={data?.points ?? []} grain={monitor.grain} />
        <p className="text-[11px] text-gray-600">
          Shaded: the normal range. Red: anomalies, missing or zero periods and level shifts; amber: warnings and restated values.
          {data?.target ? ` Target ${data.target}.` : ''}
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-gray-300">Flagged periods</h3>
          {flagged.length === 0 ? <p className="text-[11px] text-gray-600">Nothing flagged in the stored history.</p> : (
            <ul className="flex flex-col divide-y divide-gray-800 border border-gray-800 rounded max-h-64 overflow-auto">
              {flagged.map((p) => (
                <li key={p.period} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="font-mono text-gray-300 w-24 shrink-0">{p.period}</span>
                  <span className={`flex-1 truncate ${p.suppressed ? 'text-gray-500' : kindTone(p.kind) === 'fail' ? 'text-red-300' : 'text-amber-300'}`}>
                    {p.suppressed ? 'Marked as expected' : KIND_LABEL[p.kind]} · {formatNumber(p.value)}
                    {p.expected !== null ? ` vs ~${formatNumber(p.expected)}` : ''}
                  </span>
                  <button onClick={() => onSuppress(slice, p.period, !p.suppressed)}
                    title={p.suppressed ? 'Flag this period again' : 'Not a problem: stop flagging it and leave it out of future baselines'}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-700 text-[11px] text-gray-400 hover:text-gray-200">
                    {p.suppressed ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                    {p.suppressed ? 'Undo' : 'Mark as expected'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-2 text-xs font-medium text-gray-300">Restated periods</h3>
          {(data?.restatements ?? []).length === 0 ? (
            <p className="text-[11px] text-gray-600">No past period has changed after it ended.</p>
          ) : (
            <ul className="flex flex-col gap-0.5 text-[11px] text-gray-400 max-h-40 overflow-auto">
              {data!.restatements.map((r) => (
                <li key={r.period}><span className="font-mono text-gray-300">{r.period}</span>: {formatNumber(r.previous_value)} → {formatNumber(r.value)}</li>
              ))}
            </ul>
          )}
        </section>

        <MonitorSettings monitor={monitor} targets={targets} onUpdate={onUpdate} onDelete={remove} />
      </div>

      <section className="flex flex-col gap-2 min-h-0">
        <h3 className="text-xs font-medium text-gray-300">Stored history</h3>
        <div className="h-72 min-h-0 border border-gray-800 rounded overflow-hidden">
          <DataTable columns={POINT_COLUMNS} rows={[...clampBand(data?.points ?? [])].reverse().map(pointRow)} />
        </div>
      </section>
    </div>
  );
}

function MonitorSettings({ monitor, targets, onUpdate, onDelete }: {
  monitor: MonitorDto; targets: string[]; onUpdate: (body: MonitorPatchBody) => void; onDelete: () => void;
}) {
  const [lookback, setLookback] = useState(String(monitor.lookback));
  return (
    <section className="flex flex-col gap-2.5 text-xs">
      <h3 className="font-medium text-gray-300">Settings</h3>
      <label className="flex items-center justify-between gap-3">
        <span className="text-gray-400">Sensitivity</span>
        <select value={monitor.sensitivity} onChange={(e) => onUpdate({ sensitivity: e.target.value as MonitorSensitivity })} className={FIELD_CLS}>
          <option value="low">low</option><option value="normal">normal</option><option value="high">high</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-3">
        <span className="text-gray-400">History kept ({monitor.grain}s)</span>
        <input type="number" min={1} value={lookback} onChange={(e) => setLookback(e.target.value)}
          onBlur={() => { const n = Math.floor(Number(lookback)); if (n > 0 && n !== monitor.lookback) onUpdate({ lookback: n }); }}
          className={`${FIELD_CLS} w-24 text-right`} />
      </label>
      {targets.length > 0 && (
        <label className="flex items-center justify-between gap-3">
          <span className="text-gray-400">Target</span>
          <select value={monitor.target ?? ''} onChange={(e) => onUpdate({ target: e.target.value || null })} className={FIELD_CLS}>
            <option value="">Follow the active target</option>
            {targets.map((t) => <option key={t} value={t}>Always {t}</option>)}
          </select>
        </label>
      )}
      <label className="flex items-center justify-between gap-3">
        <span className="text-gray-400">Enabled</span>
        <input type="checkbox" checked={monitor.enabled} onChange={(e) => onUpdate({ enabled: e.target.checked })} />
      </label>
      <p className="text-[11px] text-gray-600 leading-relaxed">
        Late-arriving data shows as a drop in the latest period, then as a restatement once it lands.
        The current period is shown but never scored.
      </p>
      <button onClick={onDelete} className="self-start flex items-center gap-1.5 px-2.5 py-1 rounded border border-red-900/60 text-red-300 hover:bg-red-950/40">
        <Trash2 className="w-3.5 h-3.5" />Delete monitor
      </button>
    </section>
  );
}
