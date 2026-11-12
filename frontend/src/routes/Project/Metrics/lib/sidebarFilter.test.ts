import { describe, expect, it } from 'vitest';
import type { CatalogMetric, CatalogSavedQuery } from '../../../../lib/semanticApi';
import { EMPTY_SIDEBAR_FILTER, filterMetrics, filterSavedQueries, modelOptions, typeOptions } from './sidebarFilter';

function metric(name: string, type: string, semantic_models: string[], label: string | null = null): CatalogMetric {
  return { name, label, description: null, type, dimensions: [], semantic_models };
}

function saved(name: string, metrics: string[]): CatalogSavedQuery {
  return { name, label: null, description: null, metrics, group_by: [], where: [] };
}

const METRICS = [
  metric('revenue', 'simple', ['orders'], 'Revenue'),
  metric('order_count', 'simple', ['orders']),
  metric('aov', 'ratio', ['orders']),
  metric('signups', 'simple', ['customers']),
  metric('revenue_per_customer', 'derived', ['orders', 'customers']),
  metric('orphan', 'cumulative', []),
];

describe('modelOptions', () => {
  it('lists every semantic model once, sorted', () => {
    expect(modelOptions(METRICS)).toEqual(['customers', 'orders']);
  });
});

describe('typeOptions', () => {
  it('lists the types present in the known order', () => {
    expect(typeOptions(METRICS)).toEqual(['simple', 'ratio', 'cumulative', 'derived']);
  });

  it('appends unknown types after the known ones', () => {
    expect(typeOptions([metric('x', 'weird', []), metric('y', 'simple', [])])).toEqual(['simple', 'weird']);
  });
});

describe('filterMetrics', () => {
  const names = (ms: CatalogMetric[]) => ms.map((m) => m.name);

  it('returns everything with no filter', () => {
    expect(filterMetrics(METRICS, EMPTY_SIDEBAR_FILTER)).toEqual(METRICS);
  });

  it('matches search on name or label, case-insensitively', () => {
    expect(names(filterMetrics(METRICS, { ...EMPTY_SIDEBAR_FILTER, search: '  REVENUE ' }))).toEqual(['revenue', 'revenue_per_customer']);
  });

  it('also matches descriptions, types and semantic models', () => {
    const described = [...METRICS, { ...metric('users', 'simple', ['people']), description: 'Active buyers' }];
    const search = (q: string) => names(filterMetrics(described, { ...EMPTY_SIDEBAR_FILTER, search: q }));
    expect(search('BUYERS')).toEqual(['users']);
    expect(search('ratio')).toEqual(['aov']);
    expect(search('people')).toEqual(['users']);
    expect(search(' ')).toHaveLength(described.length);
  });

  it('keeps metrics in any selected semantic model', () => {
    const f = { ...EMPTY_SIDEBAR_FILTER, models: new Set(['customers']) };
    expect(names(filterMetrics(METRICS, f))).toEqual(['signups', 'revenue_per_customer']);
  });

  it('keeps metrics of any selected type', () => {
    const f = { ...EMPTY_SIDEBAR_FILTER, types: new Set(['ratio', 'derived']) };
    expect(names(filterMetrics(METRICS, f))).toEqual(['aov', 'revenue_per_customer']);
  });

  it('combines search, models and types with AND', () => {
    const f = { search: 'rev', models: new Set(['orders']), types: new Set(['simple']) };
    expect(names(filterMetrics(METRICS, f))).toEqual(['revenue']);
  });
});

describe('filterSavedQueries', () => {
  const QUERIES = [saved('daily_revenue', ['revenue']), saved('growth', ['signups']), saved('mixed', ['aov', 'signups'])];
  const names = (qs: CatalogSavedQuery[]) => qs.map((q) => q.name);

  it('matches search only when no model or type filter is set', () => {
    expect(names(filterSavedQueries(QUERIES, METRICS, { ...EMPTY_SIDEBAR_FILTER, search: 'grow' }))).toEqual(['growth']);
  });

  it('keeps queries using at least one metric that passes the model and type filters', () => {
    const f = { ...EMPTY_SIDEBAR_FILTER, types: new Set(['ratio']) };
    expect(names(filterSavedQueries(QUERIES, METRICS, f))).toEqual(['mixed']);
  });

  it('ignores the search text when deciding which metrics a query must use', () => {
    const f = { search: 'daily', models: new Set(['orders']), types: new Set<string>() };
    expect(names(filterSavedQueries(QUERIES, METRICS, f))).toEqual(['daily_revenue']);
  });
});
