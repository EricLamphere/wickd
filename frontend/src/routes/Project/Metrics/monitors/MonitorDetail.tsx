// One monitor: the history chart with its expected band, flagged periods (mark as
// expected, with metric notes), restated periods, every stored point, and the monitor's settings.
// Notes covering its periods are bands on the chart; right-click a period to add one (plan 30).
import { useMemo, useState } from 'react';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import { Switch } from '../../../../components/Switch';
import { confirmDialog } from '../../../../lib/dialogs';
import type { MonitorDto, MonitorListDto, MonitorPatchBody, MonitorPointDto } from '../../../../lib/monitorsApi';
import { AlgorithmFields, type AlgorithmValue } from './AlgorithmFields';
import { configProblem } from './algorithms';
import { MonitorChart } from './MonitorChart';
import { FlaggedPeriods, type SuppressResult } from './FlaggedPeriods';
import { useExpectations } from './useExpectations';
import { useAddNoteMenu } from '../notes/AddNoteMenu';
import { notesFor, periodEnd } from '../notes/lib/metricNotes';
import { useProjectNotes } from '../notes/useNotes';
import { MonitorScheduleSetting } from './ScheduleControls';
import { clampBand, formatNumber, KIND_LABEL, monitorTitle, statusStyle } from './monitorView';
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
  /** the project's schedule, which the monitor follows unless it has its own */
  project: Pick<MonitorListDto, 'interval_hours' | 'schedule'>;
  onBack: () => void;
  onUpdate: (body: MonitorPatchBody) => Promise<unknown>;
  onDelete: () => void;
  onRefresh: () => void;
  onSuppress: (slice: string, period: string, suppressed: boolean) => Promise<SuppressResult>;
  /** the metric's label, for note titles */
  label?: string | null;
  /** the last failed action (save, check, mark as expected), if any */
  error: string | null;
}

const round = (v: number | null | undefined) => (typeof v === 'number' ? Number(v.toFixed(2)) : null);

function pointRow(p: MonitorPointDto): unknown[] {
  const flag = p.partial ? 'in progress' : p.suppressed ? 'marked as expected' : KIND_LABEL[p.kind];
  return [p.period, round(p.value), round(p.expected), round(p.low), round(p.high), round(p.score), flag];
}

export function MonitorDetail({ projectId, monitor, targets, running, project, onBack, onUpdate, onDelete, onRefresh, onSuppress, label = null, error }: Props) {
  const [slice, setSlice] = useState(monitor.latest?.worst_slice ?? (monitor.dimension ? String(monitor.slices[0] ?? '') : ''));
  const series = useMonitorSeries(projectId, monitor.id, slice);
  const data = series.data;
  const style = statusStyle(data?.summary.status, running);
  const flagged = (data?.points ?? []).filter((p) => (p.kind !== 'none' || p.suppressed) && !p.partial).reverse();
  const expectations = useExpectations(projectId);
  const allNotes = useProjectNotes();
  const points = data?.points ?? [];
  const first = points[0]?.period;
  const last = points[points.length - 1]?.period;
  const notes = useMemo(() => (first && last ? notesFor(allNotes, {
    start: first, end: periodEnd(last, monitor.grain), metrics: [monitor.metric],
    dims: monitor.dimension && slice ? { [monitor.dimension]: slice } : {},
  }) : []), [allNotes, first, last, monitor.grain, monitor.metric, monitor.dimension, slice]);
  const noteMenu = useAddNoteMenu();

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
      {error && <p className="text-xs text-red-400">{error}</p>}

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
        <MonitorChart points={points} grain={monitor.grain} notes={notes}
          onPeriodMenu={(period, e) => noteMenu.open(e, `${monitor.metric} · ${period}`, {
            kind: 'period', metric: monitor.metric, period, grain: monitor.grain, dimension: monitor.dimension, value: slice || null,
          })} />
        {noteMenu.menu}
        <p className="text-[11px] text-gray-600">
          Shaded: the normal range. Red: anomalies, missing or zero periods and level shifts; amber: warnings and restated values.
          {data?.target ? ` Target ${data.target}.` : ''}
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-gray-300">Flagged periods</h3>
          <FlaggedPeriods projectId={projectId} monitor={monitor} slice={slice} flagged={flagged} notes={notes}
            expectations={expectations.data?.expectations ?? []} label={label} onSuppress={onSuppress} />
          {flagged.length > 0 && (
            <p className="text-[11px] text-gray-600 leading-relaxed">
              A period marked as expected is left out of the baseline, so the expected values, normal range and
              scores of other periods (in the chart and the stored history below) can shift when you mark or undo one.
            </p>
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

        <MonitorSettings monitor={monitor} targets={targets} project={project} onUpdate={onUpdate} onDelete={remove} />
      </div>

      <section className="flex flex-col gap-2 min-h-0">
        <h3 className="text-xs font-medium text-gray-300">Stored history</h3>
        {/* every period the chart shows, newest first; scrolls inside a fixed height */}
        <div className="h-96 min-h-0">
          <DataTable className="h-full" columns={POINT_COLUMNS} rows={[...clampBand(data?.points ?? [])].reverse().map(pointRow)} />
        </div>
      </section>
    </div>
  );
}

const algorithmOf = (m: MonitorDto): AlgorithmValue => ({
  algorithm: m.algorithm ?? 'seasonal', config: m.config ?? {}, sensitivity: m.sensitivity,
});

/** The algorithm and its settings, edited as a draft and saved together (a check runs after). */
function AlgorithmSetting({ monitor, onUpdate }: { monitor: MonitorDto; onUpdate: (body: MonitorPatchBody) => Promise<unknown> }) {
  const saved = algorithmOf(monitor);
  const [draft, setDraft] = useState<AlgorithmValue>(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const problem = configProblem(draft.algorithm, draft.config);
  const save = () => {
    const body: MonitorPatchBody = draft.algorithm === 'seasonal'
      ? { algorithm: 'seasonal', sensitivity: draft.sensitivity }
      : { algorithm: draft.algorithm, config: draft.config };
    void onUpdate(body);
  };
  return (
    <div className="flex flex-col gap-2 pb-2.5 border-b border-gray-800">
      <AlgorithmFields value={draft} onChange={setDraft} />
      {problem && <p className="text-[11px] text-amber-400">{problem}</p>}
      {dirty && (
        <div className="flex justify-end gap-2">
          <button onClick={() => setDraft(saved)} className="px-2.5 py-1 rounded border border-gray-700 text-gray-300 hover:border-gray-500">Discard</button>
          <button onClick={save} disabled={!!problem}
            className="px-2.5 py-1 rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">Save and check</button>
        </div>
      )}
    </div>
  );
}

function MonitorSettings({ monitor, targets, project, onUpdate, onDelete }: {
  monitor: MonitorDto; targets: string[]; project: Pick<MonitorListDto, 'interval_hours' | 'schedule'>;
  onUpdate: (body: MonitorPatchBody) => Promise<unknown>; onDelete: () => void;
}) {
  const [lookback, setLookback] = useState(String(monitor.lookback));
  return (
    <section className="flex flex-col gap-2.5 text-xs">
      <h3 className="font-medium text-gray-300">Settings</h3>
      <AlgorithmSetting key={`${monitor.id}:${monitor.algorithm}:${JSON.stringify(monitor.config)}:${monitor.sensitivity}`}
        monitor={monitor} onUpdate={onUpdate} />
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
      <MonitorScheduleSetting monitor={monitor} project={project} onUpdate={onUpdate} />
      <div className="flex items-center justify-between gap-3">
        <span className="text-gray-400">Enabled</span>
        <Switch checked={monitor.enabled} onChange={(on) => onUpdate({ enabled: on })} label="Enable this monitor"
          title={monitor.enabled ? 'On: click to stop checking this monitor' : 'Off: click to check this monitor again'} />
      </div>
      <p className="text-[11px] text-gray-600 leading-relaxed">
        {(monitor.algorithm ?? 'seasonal') === 'seasonal'
          ? 'Late-arriving data shows as a drop in the latest period, then as a restatement once it lands.'
          : 'Restated periods (values that changed after the period ended) are flagged with every algorithm.'}
        {' '}The current period is shown but never scored.
      </p>
      <button onClick={onDelete} className="self-start flex items-center gap-1.5 px-2.5 py-1 rounded border border-red-900/60 text-red-300 hover:bg-red-950/40">
        <Trash2 className="w-3.5 h-3.5" />Delete monitor
      </button>
    </section>
  );
}
