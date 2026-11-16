import { describe, expect, it } from 'vitest';
import { algorithmLabel, algorithmSummary, configProblem, defaultConfig, parseNumberField } from './algorithms';

describe('monitor algorithms', () => {
  it('names each algorithm', () => {
    expect(algorithmLabel('seasonal')).toBe('Seasonal anomaly');
    expect(algorithmLabel('no_data')).toBe('No data or zero');
  });

  it('summarizes the settings', () => {
    expect(algorithmSummary('seasonal', {}, 'high')).toBe('Seasonal anomaly · high sensitivity');
    expect(algorithmSummary('no_data', defaultConfig('no_data'), 'normal')).toBe('No data or zero: missing data or zeros');
    expect(algorithmSummary('no_data', { check_zeros: false, periods: 3 }, 'normal')).toBe('No data or zero: missing data · last 3 periods');
    expect(algorithmSummary('threshold', { min: 10, max: 2000 }, 'normal')).toBe('Fixed bounds: ≥ 10 and ≤ 2,000');
    expect(algorithmSummary('change', { max_change_pct: 25, direction: 'down' }, 'normal')).toBe('Change down > 25%');
  });

  it('flags settings the backend would refuse', () => {
    expect(configProblem('seasonal', {})).toBeNull();
    expect(configProblem('no_data', { check_nulls: false, check_zeros: false })).toMatch(/both/);
    expect(configProblem('threshold', defaultConfig('threshold'))).toMatch(/minimum, a maximum/);
    expect(configProblem('threshold', { min: 5, max: 1 })).toMatch(/not be above/);
    expect(configProblem('threshold', { min: 1 })).toBeNull();
    expect(configProblem('change', { max_change_pct: 0 })).toMatch(/above 0/);
    expect(configProblem('change', { max_change_pct: 10, periods: 31 })).toMatch(/1 to 30/);
  });

  it('reads number fields', () => {
    expect(parseNumberField('')).toBeNull();
    expect(parseNumberField(' 12.5 ')).toBe(12.5);
    expect(parseNumberField('abc')).toBeUndefined();
  });
});
