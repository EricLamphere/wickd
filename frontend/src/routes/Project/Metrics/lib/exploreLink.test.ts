import { describe, expect, it } from 'vitest';
import { exploreSearch, metricPageUrl, previewBody, requestSearch } from './exploreLink';
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

describe('requestSearch', () => {
  it('turns a MetricFlow request into the explorer state that rebuilds it', () => {
    const body = {
      metrics: ['revenue'], group_by: ['metric_time__week', 'customer__region'],
      where: ["{{ Dimension('customer__region') }} = 'EMEA'"], order_by: ['-metric_time__week'], limit: 100, start: '2026-03-01',
    };
    const state = stateFromParams(new URLSearchParams(requestSearch(body)));
    expect(state).toMatchObject({ metrics: ['revenue'], groupBy: ['metric_time', 'customer__region'], grain: 'week',
      orderBy: ['-metric_time'], limit: 100, start: '2026-03-01' });
    const options: GroupByOption[] = [TIME, { name: 'customer__region', kind: 'categorical', nativeGrain: null, label: null, description: null }];
    expect(toRequest(state, options)).toEqual(body);
    expect(requestSearch({ saved_query: 'weekly' })).toBe('saved=weekly');
  });
});

describe('metricPageUrl', () => {
  it("opens a metric's page on the Explore tab", () => {
    expect(metricPageUrl(4, 'revenue')).toBe('/projects/4/metrics?tab=explore&metric=revenue');
  });
});
