// The monitor algorithm picker and its settings, shared by CreateMonitorDialog and the
// monitor detail's Settings. Controlled: `value` in, every edit out through onChange (number
// fields keep what's typed until it reads as a number).
import { useState } from 'react';
import type { MonitorAlgorithm, MonitorAlgorithmConfig, MonitorSensitivity } from '../../../../lib/monitorsApi';
import { ALGORITHMS, defaultConfig, MAX_PERIODS, parseNumberField } from './algorithms';

export interface AlgorithmValue {
  algorithm: MonitorAlgorithm;
  config: MonitorAlgorithmConfig;
  sensitivity: MonitorSensitivity;
}

export const FIELD_CLS = 'w-full px-2 py-1.5 bg-surface-app border border-gray-700 rounded text-xs text-gray-200 outline-none focus:border-brand-600';

const SENSITIVITY: { value: MonitorSensitivity; label: string }[] = [
  { value: 'low', label: 'Low: only large deviations' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High: flags smaller deviations, more false alarms' },
];

function NumberField({ label, value, onChange, placeholder, min }: {
  label: string; value: number | null | undefined; onChange: (n: number | null) => void; placeholder?: string; min?: number;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const bad = parseNumberField(text) === undefined;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-gray-400">{label}</span>
      <input type="text" inputMode="decimal" value={text} placeholder={placeholder} aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseNumberField(e.target.value);
          if (n !== undefined && (min === undefined || n === null || n >= min)) onChange(n);
        }}
        className={`${FIELD_CLS} ${bad ? 'border-red-600' : ''}`} />
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-gray-300">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-brand-600" />
      {label}
    </label>
  );
}

function Settings({ value, set }: { value: AlgorithmValue; set: (patch: MonitorAlgorithmConfig) => void }) {
  const { algorithm, config } = value;
  if (algorithm === 'no_data') {
    return (
      <div className="flex flex-col gap-1.5">
        <Check label="Flag periods with no data" checked={config.check_nulls !== false} onChange={(v) => set({ check_nulls: v })} />
        <Check label="Flag periods that are zero" checked={config.check_zeros !== false} onChange={(v) => set({ check_zeros: v })} />
      </div>
    );
  }
  if (algorithm === 'threshold') {
    return (
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Minimum" value={config.min} placeholder="none" onChange={(n) => set({ min: n })} />
        <NumberField label="Maximum" value={config.max} placeholder="none" onChange={(n) => set({ max: n })} />
      </div>
    );
  }
  if (algorithm === 'change') {
    return (
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Largest normal change (%)" value={config.max_change_pct} min={0}
          onChange={(n) => set({ max_change_pct: n ?? undefined })} />
        <label className="flex flex-col gap-1">
          <span className="text-gray-400">Direction</span>
          <select value={config.direction ?? 'both'} onChange={(e) => set({ direction: e.target.value as MonitorAlgorithmConfig['direction'] })}
            className={FIELD_CLS}>
            <option value="both">Up or down</option>
            <option value="up">Only increases</option>
            <option value="down">Only decreases</option>
          </select>
        </label>
      </div>
    );
  }
  return null;
}

export function AlgorithmFields({ value, onChange }: { value: AlgorithmValue; onChange: (next: AlgorithmValue) => void }) {
  const info = ALGORITHMS.find((a) => a.value === value.algorithm);
  const set = (patch: MonitorAlgorithmConfig) => onChange({ ...value, config: { ...value.config, ...patch } });
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-gray-400">Algorithm</span>
        <select value={value.algorithm} className={FIELD_CLS}
          onChange={(e) => {
            const algorithm = e.target.value as MonitorAlgorithm;
            onChange({ ...value, algorithm, config: defaultConfig(algorithm) });
          }}>
          {ALGORITHMS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
        {info && <span className="text-[11px] text-gray-600">{info.description}</span>}
      </label>
      {value.algorithm === 'seasonal' ? (
        <label className="flex flex-col gap-1">
          <span className="text-gray-400">Sensitivity</span>
          <select value={value.sensitivity} onChange={(e) => onChange({ ...value, sensitivity: e.target.value as MonitorSensitivity })} className={FIELD_CLS}>
            {SENSITIVITY.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      ) : (
        <>
          {/* key: switching algorithm starts its number fields from the new defaults */}
          <Settings key={value.algorithm} value={value} set={set} />
          <label className="flex items-center justify-between gap-3">
            <span className="text-gray-400">Alert when any of the last N periods is flagged</span>
            <input type="number" min={1} max={MAX_PERIODS} value={value.config.periods ?? 1}
              onChange={(e) => set({ periods: Math.floor(Number(e.target.value)) || 1 })} className={`${FIELD_CLS} w-20 text-right`} />
          </label>
        </>
      )}
    </div>
  );
}
