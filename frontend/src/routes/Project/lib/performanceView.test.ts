import { describe, expect, it } from 'vitest';
import type { RecommendationDto } from '../../../lib/api';
import { changeVsUsual, formatDuration, incrementalDraftQuestion, matchesQuery, savingLabel, typeCounts } from './performanceView';

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

describe('formatDuration', () => {
  it('uses milliseconds under a second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(0.0004)).toBe('1ms');
    expect(formatDuration(0.045)).toBe('45ms');
    expect(formatDuration(2.5)).toBe('2.5s');
    expect(formatDuration(90)).toBe('1m 30s');
  });
});

describe('changeVsUsual', () => {
  it('labels slower, faster and about the same', () => {
    expect(changeVsUsual(30, 10)).toEqual({ delta: '+20s', pct: '+200%', tone: 'slower' });
    expect(changeVsUsual(5, 10)).toEqual({ delta: '−5s', pct: '−50%', tone: 'faster' });
    expect(changeVsUsual(10.5, 10).tone).toBe('same');
    expect(changeVsUsual(1.6, 1).tone).toBe('same'); // under a second apart
    expect(changeVsUsual(3, 0).pct).toBe('');
  });
});

describe('filters', () => {
  it('matches names case-insensitively', () => {
    expect(matchesQuery('stg_Orders', 'ORD')).toBe(true);
    expect(matchesQuery('stg_orders', '  ')).toBe(true);
    expect(matchesQuery('stg_orders', 'cust')).toBe(false);
  });
  it('counts resource types, most common first', () => {
    expect(typeCounts([{ resource_type: 'test' }, { resource_type: 'model' }, { resource_type: 'model' }]))
      .toEqual([['model', 2], ['test', 1]]);
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
