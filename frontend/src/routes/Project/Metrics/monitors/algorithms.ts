// Monitor algorithms in the UI: names, what each is for, default settings, a one-line
// summary for cards, and the checks the form shows before saving (the backend validates the
// same rules: app/semantic/monitor_algorithms.py). Pure; tested in algorithms.test.ts.
import type { MonitorAlgorithm, MonitorAlgorithmConfig, MonitorSensitivity } from '../../../../lib/monitorsApi';

export interface AlgorithmInfo {
  value: MonitorAlgorithm;
  label: string;
  description: string;
}

export const ALGORITHMS: AlgorithmInfo[] = [
  { value: 'seasonal', label: 'Seasonal anomaly',
    description: 'Spikes, drops and level shifts against the metric\'s own seasonal pattern. Needs a few weeks of history.' },
  { value: 'no_data', label: 'No data or zero',
    description: 'Flags a period with no data or a zero, e.g. to check yesterday\'s data landed. Works from day one.' },
  { value: 'threshold', label: 'Fixed bounds',
    description: 'Flags a value below a minimum or above a maximum you set.' },
  { value: 'change', label: 'Period-over-period change',
    description: 'Flags a move of more than a set percentage from the period before.' },
];

export const MAX_PERIODS = 30;

export function algorithmLabel(algorithm: MonitorAlgorithm): string {
  return ALGORITHMS.find((a) => a.value === algorithm)?.label ?? algorithm;
}

export function defaultConfig(algorithm: MonitorAlgorithm): MonitorAlgorithmConfig {
  switch (algorithm) {
    case 'no_data': return { check_nulls: true, check_zeros: true, periods: 1 };
    case 'threshold': return { min: null, max: null, periods: 1 };
    case 'change': return { max_change_pct: 50, direction: 'both', periods: 1 };
    default: return {};
  }
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** What the monitor watches for, in a few words (cards, settings). */
export function algorithmSummary(algorithm: MonitorAlgorithm, config: MonitorAlgorithmConfig, sensitivity: MonitorSensitivity): string {
  const last = (config.periods ?? 1) > 1 ? ` · last ${config.periods} periods` : '';
  switch (algorithm) {
    case 'no_data': {
      const what = [config.check_nulls !== false ? 'missing data' : null, config.check_zeros !== false ? 'zeros' : null].filter(Boolean);
      return `No data or zero: ${what.join(' or ')}${last}`;
    }
    case 'threshold': {
      const bounds = [
        config.min != null ? `≥ ${fmt(config.min)}` : null,
        config.max != null ? `≤ ${fmt(config.max)}` : null,
      ].filter(Boolean);
      return `Fixed bounds: ${bounds.join(' and ') || 'not set'}${last}`;
    }
    case 'change': {
      const dir = config.direction === 'up' ? ' up' : config.direction === 'down' ? ' down' : '';
      return `Change${dir} > ${fmt(config.max_change_pct ?? 50)}%${last}`;
    }
    default: return `Seasonal anomaly · ${sensitivity} sensitivity`;
  }
}

/** Why the settings can't be saved, or null when they can. */
export function configProblem(algorithm: MonitorAlgorithm, config: MonitorAlgorithmConfig): string | null {
  const periods = config.periods ?? 1;
  if (algorithm !== 'seasonal' && (!Number.isInteger(periods) || periods < 1 || periods > MAX_PERIODS)) {
    return `Check the last 1 to ${MAX_PERIODS} periods`;
  }
  if (algorithm === 'no_data' && config.check_nulls === false && config.check_zeros === false) {
    return 'Check for missing data, zeros, or both';
  }
  if (algorithm === 'threshold') {
    if (config.min == null && config.max == null) return 'Set a minimum, a maximum, or both';
    if (config.min != null && config.max != null && config.min > config.max) return 'The minimum must not be above the maximum';
  }
  if (algorithm === 'change' && !((config.max_change_pct ?? 0) > 0)) return 'The change must be above 0%';
  return null;
}

/** A number field's text as a value: '' → null, unreadable → undefined (kept as typed). */
export function parseNumberField(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
