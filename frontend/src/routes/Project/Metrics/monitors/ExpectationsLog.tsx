// Monitors tab → Marked as expected: every period someone marked as expected, newest first, with
// what it was flagged as, value vs expected, when, and its note (plan 30). Entries outlive the
// monitor's stored history (it's trimmed to the lookback). Filterable by monitor.
import { useState } from 'react';
import { StickyNote } from 'lucide-react';
import type { MonitorDto, MonitorExpectationDto } from '../../../../lib/monitorsApi';
import { relativeTime } from '../../lib/relativeTime';
import { addMetricNote, openMetricNote } from '../notes/noteEvents';
import { expectedPrefill } from '../notes/lib/metricNotes';
import { formatNumber, KIND_LABEL } from './monitorView';
import { useExpectations } from './useExpectations';

const FIELD = 'px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

function NoteCell({ entry, monitor }: { entry: MonitorExpectationDto; monitor: MonitorDto | undefined }) {
  if (entry.note_slug && !entry.note_missing) {
    return (
      <button onClick={() => openMetricNote(entry.note_slug!)} className="flex items-center gap-1 text-[11px] text-amber-300 hover:brightness-125">
        <StickyNote className="w-3 h-3" />Note
      </button>
    );
  }
  const add = () => addMetricNote(expectedPrefill({
    metric: entry.metric, period: entry.period, grain: monitor?.grain ?? 'day', kind: entry.kind, value: entry.value,
    expected: entry.expected, dimension: entry.dimension, slice: entry.slice, format: formatNumber,
  }), { expectationId: entry.id });
  return (
    <button onClick={add} className="text-[11px] text-gray-400 hover:text-gray-200" title={entry.note_missing ? `${entry.note_slug}: note missing` : undefined}>
      {entry.note_missing ? 'Note missing · add' : 'Add note'}
    </button>
  );
}

export function ExpectationsLog({ projectId, monitors, onOpenMonitor }: {
  projectId: number; monitors: MonitorDto[]; onOpenMonitor: (id: number) => void;
}) {
  const { data } = useExpectations(projectId);
  const [monitorId, setMonitorId] = useState<number | null>(null);
  const all = data?.expectations ?? [];
  if (!all.length) return null;
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const rows = monitorId === null ? all : all.filter((e) => e.monitor_id === monitorId);
  return (
    <section className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-3">
        <h3 className="text-xs font-medium text-gray-300">Marked as expected</h3>
        <select value={monitorId ?? ''} onChange={(e) => setMonitorId(e.target.value ? Number(e.target.value) : null)} aria-label="Monitor" className={FIELD}>
          <option value="">Every monitor</option>
          {monitors.map((m) => <option key={m.id} value={m.id}>{m.metric}{m.dimension ? ` by ${m.dimension}` : ''} ({m.grain})</option>)}
        </select>
      </div>
      <ul className="flex flex-col divide-y divide-gray-800 border border-gray-800 rounded max-h-80 overflow-auto">
        {rows.map((e) => (
          <li key={e.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
            <button onClick={() => onOpenMonitor(e.monitor_id)} className="w-40 shrink-0 truncate text-left text-gray-200 hover:text-brand-300"
              title={byId.has(e.monitor_id) ? 'Open the monitor' : undefined}>
              {e.metric}{e.slice ? ` · ${e.slice}` : ''}
            </button>
            <span className="w-24 shrink-0 font-mono text-gray-300">{e.period}</span>
            <span className="flex-1 truncate text-gray-400">
              {e.kind ? KIND_LABEL[e.kind] : 'Not flagged'} · {formatNumber(e.value)}{e.expected !== null ? ` vs ~${formatNumber(e.expected)}` : ''}
            </span>
            <span className="shrink-0 text-[10px] text-gray-500" title={e.marked_at ? new Date(e.marked_at).toLocaleString() : undefined}>
              {e.marked_at ? relativeTime(e.marked_at) : ''}
            </span>
            <span className="w-24 shrink-0 flex justify-end"><NoteCell entry={e} monitor={byId.get(e.monitor_id)} /></span>
          </li>
        ))}
      </ul>
    </section>
  );
}
