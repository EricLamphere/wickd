import { describe, expect, it } from 'vitest';
import type { RecommendationDto } from '../../../lib/api';
import { incrementalDraftQuestion, regressionRows, savingLabel, slowestRows, textSparkline } from './performanceView';

const rec = (over: Partial<RecommendationDto> = {}): RecommendationDto => ({
  kind: 'make_incremental',
  unique_id: 'model.p.orders',
  name: 'orders',
  title: 'Make orders incremental',
  evidence: ['Last 3 runs: 40s, 41s, 42s', '`updated_at` looks like a natural incremental filter'],
  confidence: 'high',
  estimated_saving_s: null,
  invocation_id: 1,
  ...over,
});

describe('textSparkline', () => {
  it('scales between the min and max', () => {
    expect(textSparkline([1, 5, 9])).toBe('▁▅█');
  });
  it('draws a flat series in the middle', () => {
    expect(textSparkline([3, 3])).toBe('▄▄');
  });
  it('is empty for no data', () => {
    expect(textSparkline([])).toBe('');
  });
});

describe('rows', () => {
  it('formats slowest nodes', () => {
    expect(slowestRows([{
      unique_id: 'model.p.a', name: 'a', resource_type: 'model', median_s: 90, last_s: 2.5, runs: 3, recent: [1, 2, 3],
    }])).toEqual([['a', 'model', '1m 30s', '2.5s', 3, '▁▅█']]);
  });
  it('formats regressions with the slowdown', () => {
    expect(regressionRows([{
      unique_id: 'model.p.a', name: 'a', current: 30, baseline_median: 10, ratio: 3, runs_considered: 5,
    }])).toEqual([['a', '30s', '10s', '+20s (200%)', 5]]);
  });
});

describe('labels', () => {
  it('shows a saving only when estimated', () => {
    expect(savingLabel(rec())).toBeNull();
    expect(savingLabel(rec({ estimated_saving_s: 30 }))).toBe('saves up to ~30s');
  });
  it('asks Wicky for an incremental draft, passing the timestamp hint', () => {
    const q = incrementalDraftQuestion(rec());
    expect(q).toContain('orders');
    expect(q).toContain('updated_at looks like a natural incremental filter');
    expect(q).not.toContain('`');
  });
});
