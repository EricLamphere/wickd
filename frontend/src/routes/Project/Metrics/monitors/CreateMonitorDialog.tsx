// "Monitor this metric": metric, grain, the algorithm (seasonal anomaly with its
// sensitivity, no data or zero, fixed bounds, period-over-period change) and its settings, an
// optional dimension to slice by (top 10 values) and an optional pinned target. Opened from the Monitors tab or
// pre-filled from the explorer.
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { MonitorCreateBody, MonitorGrain } from '../../../../lib/monitorsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { MetricChooser } from '../MetricChooser';
import { AlgorithmFields, FIELD_CLS, type AlgorithmValue } from './AlgorithmFields';
import { configProblem } from './algorithms';

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

const GRAINS: MonitorGrain[] = ['day', 'week', 'month'];

/** A metric's categorical dimensions (a monitor slices by one of these). */
export function sliceDimensions(catalog: SemanticCatalogDto, metric: string): string[] {
  const entry = catalog.metrics.find((m) => m.name === metric);
  return (entry?.dimensions ?? []).filter((d) => d.type !== 'time' && !d.time_granularity).map((d) => d.name);
}

export function CreateMonitorDialog({ catalog, initial, targets, busy, error, onCreate, onClose }: Props) {
  const [metric, setMetric] = useState(initial?.metric ?? catalog.metrics[0]?.name ?? '');
  const [grain, setGrain] = useState<MonitorGrain>(initial?.grain ?? 'day');
  const [dimension, setDimension] = useState<string>(initial?.dimension ?? '');
  const [algo, setAlgo] = useState<AlgorithmValue>({ algorithm: 'seasonal', config: {}, sensitivity: 'normal' });
  const problem = configProblem(algo.algorithm, algo.config);
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

  const submit = () => onCreate({
    metric, grain, dimension: dimension || null, sensitivity: algo.sensitivity, target: target || null,
    algorithm: algo.algorithm, config: algo.config,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="flex flex-col w-full max-w-md bg-gray-900 rounded-xl shadow-2xl border border-gray-700 overflow-hidden"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Monitor a metric">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="font-semibold text-gray-100">Monitor a metric</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4 text-xs">
          <div className="flex flex-col gap-1">
            <span className="text-gray-400">Metric</span>
            <MetricChooser catalog={catalog} value={metric || null} onPick={setMetric} ariaLabel="Metric" />
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">Grain</span>
            <select value={grain} onChange={(e) => setGrain(e.target.value as MonitorGrain)} className={FIELD_CLS}>
              {GRAINS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <AlgorithmFields value={algo} onChange={setAlgo} />
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
          {problem && <p className="text-[11px] text-amber-400">{problem}</p>}
          {error && <p className="text-[11px] text-red-400 break-words">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-800">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">Cancel</button>
          <button onClick={submit} disabled={!metric || busy || !!problem}
            className="px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
            {busy ? 'Creating…' : 'Create monitor'}
          </button>
        </div>
      </div>
    </div>
  );
}
