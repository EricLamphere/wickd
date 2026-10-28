// "Monitor this metric": metric, grain, an optional dimension to slice by (top 10
// values), sensitivity and an optional pinned target. Opened from the Monitors tab or
// pre-filled from the explorer.
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { MonitorCreateBody, MonitorGrain, MonitorSensitivity } from '../../../../lib/monitorsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';

export interface MonitorDraft {
  metric: string;
  grain: MonitorGrain;
  dimension: string | null;
}

interface Props {
  catalog: SemanticCatalogDto;
  initial: MonitorDraft | null;
  targets: string[];
  busy: boolean;
  error: string | null;
  onCreate: (body: MonitorCreateBody) => void;
  onClose: () => void;
}

const FIELD_CLS = 'w-full px-2 py-1.5 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';
const GRAINS: MonitorGrain[] = ['day', 'week', 'month'];
const SENSITIVITY: { value: MonitorSensitivity; label: string }[] = [
  { value: 'low', label: 'Low: only large deviations' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High: flags smaller deviations, more false alarms' },
];

/** A metric's categorical dimensions (a monitor slices by one of these). */
export function sliceDimensions(catalog: SemanticCatalogDto, metric: string): string[] {
  const entry = catalog.metrics.find((m) => m.name === metric);
  return (entry?.dimensions ?? []).filter((d) => d.type !== 'time' && !d.time_granularity).map((d) => d.name);
}

export function CreateMonitorDialog({ catalog, initial, targets, busy, error, onCreate, onClose }: Props) {
  const [metric, setMetric] = useState(initial?.metric ?? catalog.metrics[0]?.name ?? '');
  const [grain, setGrain] = useState<MonitorGrain>(initial?.grain ?? 'day');
  const [dimension, setDimension] = useState<string>(initial?.dimension ?? '');
  const [sensitivity, setSensitivity] = useState<MonitorSensitivity>('normal');
  const [target, setTarget] = useState('');
  const dims = sliceDimensions(catalog, metric);

  useEffect(() => {
    if (dimension && !dims.includes(dimension)) setDimension('');
  }, [dims, dimension]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => onCreate({ metric, grain, dimension: dimension || null, sensitivity, target: target || null });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="flex flex-col w-full max-w-md bg-gray-900 rounded-xl shadow-2xl border border-gray-700 overflow-hidden"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Monitor a metric">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="font-semibold text-gray-100">Monitor a metric</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">Metric</span>
            <select value={metric} onChange={(e) => setMetric(e.target.value)} className={FIELD_CLS}>
              {catalog.metrics.map((m) => <option key={m.name} value={m.name}>{m.label || m.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-gray-400">Grain</span>
              <select value={grain} onChange={(e) => setGrain(e.target.value as MonitorGrain)} className={FIELD_CLS}>
                {GRAINS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-gray-400">Sensitivity</span>
              <select value={sensitivity} onChange={(e) => setSensitivity(e.target.value as MonitorSensitivity)} className={FIELD_CLS}>
                {SENSITIVITY.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">Slice by (optional)</span>
            <select value={dimension} onChange={(e) => setDimension(e.target.value)} className={FIELD_CLS} disabled={dims.length === 0}>
              <option value="">{dims.length ? 'Whole metric' : 'No categorical dimensions'}</option>
              {dims.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <span className="text-[11px] text-gray-600">Watches the top 10 values separately, recomputed weekly.</span>
          </label>
          {targets.length > 1 && (
            <label className="flex flex-col gap-1">
              <span className="text-gray-400">Target</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)} className={FIELD_CLS}>
                <option value="">Follow the active target</option>
                {targets.map((t) => <option key={t} value={t}>Always {t}</option>)}
              </select>
              <span className="text-[11px] text-gray-600">History is kept per target, so dev and prod never share a baseline.</span>
            </label>
          )}
          <p className="text-[11px] text-gray-500 leading-relaxed">
            The first check loads up to {grain === 'day' ? '180 days' : grain === 'week' ? '52 weeks' : '24 months'} of
            history; later checks only re-read the recent periods.
          </p>
          {error && <p className="text-[11px] text-red-400 break-words">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-800">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">Cancel</button>
          <button onClick={submit} disabled={!metric || busy}
            className="px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
            {busy ? 'Creating…' : 'Create monitor'}
          </button>
        </div>
      </div>
    </div>
  );
}
