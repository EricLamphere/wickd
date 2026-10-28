import { describe, expect, it } from 'vitest';
import { exploreSearch, previewBody } from './exploreLink';
import { stateFromParams, toRequest, type GroupByOption } from './metricQuery';

const TIME: GroupByOption = { name: 'metric_time', kind: 'time', nativeGrain: 'day', label: null, description: null };

describe('exploreSearch', () => {
  it('opens a metric over metric_time at its grain', () => {
    expect(exploreSearch('metric', 'revenue')).toBe('metrics=revenue&group_by=metric_time');
    expect(exploreSearch('metric', 'revenue', { grain: 'month' })).toBe('metrics=revenue&group_by=metric_time&grain=month');
  });

  it('opens a saved query by name and a semantic model with its metrics', () => {
    expect(exploreSearch('saved_query', 'weekly')).toBe('saved=weekly');
    expect(exploreSearch('semantic_model', 'orders', { modelMetrics: ['revenue', 'orders'] }))
      .toBe('metrics=revenue%2Corders&group_by=metric_time');
    expect(exploreSearch('semantic_model', 'orders')).toBeNull();
    expect(exploreSearch('model', 'x')).toBeNull();
  });

  it('previews exactly the request the explorer sends, so the stored result matches', () => {
    for (const grain of [null, 'month']) {
      const state = stateFromParams(new URLSearchParams(exploreSearch('metric', 'revenue', { grain }) as string));
      expect(toRequest(state, [TIME])).toEqual(previewBody('revenue', grain));
    }
  });
});
