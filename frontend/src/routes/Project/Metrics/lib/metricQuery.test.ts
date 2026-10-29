import { describe, expect, it } from 'vitest';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import {
  EMPTY_STATE, allowedGrains, buildFilter, filterLabel, groupByOptions, stateFromParams,
  stateFromSavedQuery, toRequest, writeState, type ExplorerState,
} from './metricQuery';

const dim = (name: string, type = 'categorical', grain: string | null = null) =>
  ({ name, type, time_granularity: grain, label: null, description: null });

const CATALOG: SemanticCatalogDto = {
  metrics: [
    { name: 'revenue', label: 'Revenue', description: '', type: 'simple', semantic_models: ['orders'],
      dimensions: [dim('metric_time__day', 'time', 'day'), dim('customer__country'), dim('order__channel'), dim('order__order_date', 'time', 'day')] },
    { name: 'customers', label: null, description: '', type: 'simple', semantic_models: ['customers'],
      dimensions: [dim('metric_time__day', 'time', 'day'), dim('customer__country')] },
    { name: 'monthly', label: null, description: '', type: 'simple', semantic_models: ['x'],
      dimensions: [dim('metric_time__month', 'time', 'month')] },
  ],
  saved_queries: [],
};

describe('URL ⇄ state', () => {
  it('round-trips a full query and keeps unrelated params', () => {
    const state: ExplorerState = {
      metrics: ['revenue', 'customers'], groupBy: ['metric_time', 'customer__country'], grain: 'week',
      filters: ["{{ Dimension('customer__country') }} = 'US'", "{{ Dimension('order__channel') }} != 'web'"],
      start: '2026-01-01', end: '2026-06-30', orderBy: ['-revenue'], limit: 100, savedQuery: null,
    };
    const params = writeState(new URLSearchParams('tab=chart&metrics=old'), state);
    expect(params.get('tab')).toBe('chart');
    expect(stateFromParams(params)).toEqual(state);
  });

  it('defaults and drops empty values', () => {
    expect(stateFromParams(new URLSearchParams(''))).toEqual(EMPTY_STATE);
    expect(writeState(new URLSearchParams(''), EMPTY_STATE).toString()).toBe('');
    expect(stateFromParams(new URLSearchParams('limit=abc')).limit).toBeNull();
  });

  it('a saved query only writes its name', () => {
    const params = writeState(new URLSearchParams(), { ...EMPTY_STATE, metrics: ['revenue'], savedQuery: 'weekly' });
    expect(params.toString()).toBe('saved=weekly');
  });
});

describe('groupByOptions', () => {
  it('is the intersection across selected metrics, metric_time first', () => {
    expect(groupByOptions(CATALOG, ['revenue', 'customers']).map((o) => o.name)).toEqual(['metric_time', 'customer__country']);
    expect(groupByOptions(CATALOG, ['revenue']).map((o) => o.name))
      .toEqual(['metric_time', 'order__order_date', 'customer__country', 'order__channel']);
    expect(groupByOptions(CATALOG, [])).toEqual([]);
  });

  it('strips the grain suffix and keeps the native grain', () => {
    const [time] = groupByOptions(CATALOG, ['monthly']);
    expect(time).toMatchObject({ name: 'metric_time', kind: 'time', nativeGrain: 'month' });
  });
});

describe('allowedGrains', () => {
  it('starts at the coarsest native grain among selected time group-bys', () => {
    const opts = groupByOptions(CATALOG, ['monthly']);
    expect(allowedGrains(opts, ['metric_time'])).toEqual(['month', 'quarter', 'year']);
    expect(allowedGrains(groupByOptions(CATALOG, ['revenue']), ['metric_time'])).toEqual(['day', 'week', 'month', 'quarter', 'year']);
  });
});

describe('toRequest', () => {
  const opts = groupByOptions(CATALOG, ['revenue']);

  it('adds the grain to time group-bys and orders newest first by default', () => {
    expect(toRequest({ ...EMPTY_STATE, metrics: ['revenue'], groupBy: ['metric_time', 'customer__country'], grain: 'week' }, opts))
      .toEqual({ metrics: ['revenue'], group_by: ['metric_time__week', 'customer__country'], order_by: ['-metric_time__week'] });
  });

  it('passes filters, dates, limit and explicit order', () => {
    const body = toRequest({ ...EMPTY_STATE, metrics: ['revenue'], groupBy: ['metric_time'], grain: 'month', orderBy: ['metric_time'],
      filters: ['x'], start: '2026-01-01', end: '2026-02-01', limit: 10 }, opts);
    expect(body).toEqual({ metrics: ['revenue'], group_by: ['metric_time__month'], order_by: ['metric_time__month'],
      where: ['x'], start: '2026-01-01', end: '2026-02-01', limit: 10 });
  });

  it('drops group-bys no longer valid, and handles nothing picked / saved queries', () => {
    expect(toRequest({ ...EMPTY_STATE, metrics: ['revenue'], groupBy: ['gone'] }, opts)).toEqual({ metrics: ['revenue'] });
    expect(toRequest(EMPTY_STATE, opts)).toBeNull();
    expect(toRequest({ ...EMPTY_STATE, savedQuery: 'weekly' }, opts)).toEqual({ saved_query: 'weekly' });
  });
});

describe('saved queries', () => {
  it('opens a saved query definition as explorer state', () => {
    expect(stateFromSavedQuery({ metrics: ['revenue'], where: [],
      group_by: ["TimeDimension('metric_time', 'week')", "Dimension('order__channel')", "Entity('customer')"] }))
      .toMatchObject({ metrics: ['revenue'], groupBy: ['metric_time', 'order__channel', 'customer'], grain: 'week' });
  });
});

describe('filters', () => {
  const [time, , country] = groupByOptions(CATALOG, ['revenue']);

  it('builds MetricFlow where strings with quoted literals', () => {
    expect(buildFilter(country, '=', "O'Brien")).toBe("{{ Dimension('customer__country') }} = 'O''Brien'");
    expect(buildFilter(country, 'in', 'US, CA')).toBe("{{ Dimension('customer__country') }} in ('US', 'CA')");
    expect(buildFilter(country, '>=', '10')).toBe("{{ Dimension('customer__country') }} >= 10");
    expect(buildFilter(country, 'is null', '')).toBe("{{ Dimension('customer__country') }} is null");
    expect(buildFilter(time, '>=', '2026-01-01', 'week')).toBe("{{ TimeDimension('metric_time', 'week') }} >= '2026-01-01'");
  });

  it('labels filters by the names they reference', () => {
    expect(filterLabel("{{ Dimension('customer__country') }} in ('US')")).toBe("customer__country in ('US')");
    expect(filterLabel("{{ TimeDimension('metric_time', 'day') }} >= '2026-01-01'")).toBe("metric_time >= '2026-01-01'");
  });
});
