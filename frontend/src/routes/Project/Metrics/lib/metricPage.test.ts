import { describe, expect, it } from 'vitest';
import type { GraphDto, ModelNode } from '../../../../lib/api';
import type { DashboardSummaryDto } from '../../../../lib/dashboardsApi';
import type { CatalogMetric, SemanticCatalogDto, SemanticIssue } from '../../../../lib/semanticApi';
import {
  autoGrain, chartQueries, chartResult, dimensionGroups, groupMetrics, metricIssues, metricLineage, metricPageSearch, metricUsage, searchMetrics, usageCount,
} from './metricPage';

const node = (uid: string, resource_type: string): ModelNode => ({
  unique_id: uid, name: uid.split('.').pop()!, resource_type, schema_: null, database: null, materialized: null, tags: [],
  description: '', original_file_path: null, source_name: null, status: 'idle', message: null, columns: [],
  test_metadata_name: null, column_name: null, attached_node: null, patch_path: null,
});
const edge = (source: string, target: string) => ({ source, target });

// orders_src → orders → sm_orders → revenue → revenue_per_order ← order_count ← sm_orders; revenue → exposure
const graph: GraphDto = {
  nodes: [
    node('source.p.raw.orders_src', 'source'), node('model.p.orders', 'model'), node('semantic_model.p.sm_orders', 'semantic_model'),
    node('metric.p.revenue', 'metric'), node('metric.p.order_count', 'metric'), node('metric.p.revenue_per_order', 'metric'),
    node('exposure.p.board', 'exposure'),
  ],
  edges: [
    edge('source.p.raw.orders_src', 'model.p.orders'), edge('model.p.orders', 'semantic_model.p.sm_orders'),
    edge('semantic_model.p.sm_orders', 'metric.p.revenue'), edge('semantic_model.p.sm_orders', 'metric.p.order_count'),
    edge('metric.p.revenue', 'metric.p.revenue_per_order'), edge('metric.p.order_count', 'metric.p.revenue_per_order'),
    edge('metric.p.revenue', 'exposure.p.board'),
  ],
};

const metric = (name: string, semantic_models: string[], over: Partial<CatalogMetric> = {}): CatalogMetric => ({
  name, label: null, description: null, type: 'simple', dimensions: [], semantic_models, ...over,
});

describe('metricPage', () => {
  it('picks a grain for the period like dashboards do', () => {
    expect(autoGrain({ start: '2026-10-01', end: '2026-10-31' })).toBe('day');
    expect(autoGrain({ start: '2026-01-01', end: '2026-05-31' })).toBe('week');
    expect(autoGrain({ start: '2025-01-01', end: '2026-12-31' })).toBe('month');
    expect(autoGrain({ start: '2020-01-01', end: '2026-12-31' })).toBe('quarter');
    expect(autoGrain(null)).toBe('month');
  });

  it('builds the chart queries for a period and its comparison', () => {
    const today = new Date(2026, 9, 29);
    const q = chartQueries('revenue', { current: 'last_30_days', compare: 'previous_period' }, today);
    expect(q.grain).toBe('day');
    expect(q.currentBody).toEqual({ metrics: ['revenue'], group_by: ['metric_time__day'], order_by: ['metric_time__day'],
      start: q.current!.start, end: q.current!.end });
    expect((q.previousBody?.end ?? "") < q.current!.start).toBe(true);
    expect(chartQueries('revenue', { current: 'last_30_days', compare: 'none' }, today).previousBody).toBeNull();
  });

  it('wraps the batch answers as a widget result', () => {
    const q = chartQueries('revenue', { current: 'last_30_days', compare: 'previous_period' }, new Date(2026, 9, 29));
    const ok = (ran_at: string) => ({ status: 'ok' as const, error: null, result: {
      sql: 's', sql_hash: 'h', columns: ['metric_time__day', 'revenue'], rows: [['2026-10-01', 1]], truncated: false,
      ran_at, elapsed_ms: 1, target: null, profile_name: null, source: 'cache' as const } });
    const r = chartResult(q, [ok('2026-10-29T10:00:00Z'), ok('2026-10-28T10:00:00Z')]);
    expect(r.status).toBe('ok');
    expect(r.grain).toBe('day');
    expect(Object.keys(r.queries)).toEqual(['current', 'current_previous']);
    expect(r.queries.current.rows).toEqual([['2026-10-01', 1]]);
    expect(r.ran_at).toBe('2026-10-28T10:00:00Z');
    expect(chartResult(q, [ok('x'), { status: 'not_run', result: null, error: null }]).status).toBe('not_run');
    expect(chartResult(q, [{ status: 'error', result: null, error: 'boom' }]).error).toBe('boom');
  });

  it('traces where a metric comes from, through input metrics', () => {
    const l = metricLineage(graph, 'metric.p.revenue_per_order');
    expect(l.inputMetrics.map((n) => n.name)).toEqual(['order_count', 'revenue']);
    expect(l.semanticModels.map((n) => n.name)).toEqual(['sm_orders']);
    expect(l.models.map((n) => n.name)).toEqual(['orders']);
    expect(l.upstream.map((n) => n.name)).toEqual(['orders_src']);
    expect(metricLineage(graph, 'metric.p.revenue').inputMetrics).toEqual([]);
  });

  it('finds where a metric is used', () => {
    const catalog: SemanticCatalogDto = { metrics: [], saved_queries: [
      { name: 'weekly', label: null, description: null, metrics: ['revenue'], group_by: [], where: [] },
      { name: 'other', label: null, description: null, metrics: ['order_count'], group_by: [], where: [] },
    ] } as SemanticCatalogDto;
    const dashboards = [
      { slug: 'a', metrics: ['revenue'], error: null }, { slug: 'b', metrics: ['order_count'], error: null },
      { slug: 'broken', metrics: [], error: 'bad yaml' },
    ] as DashboardSummaryDto[];
    const u = metricUsage('revenue', 'metric.p.revenue', graph, catalog, dashboards);
    expect(u.savedQueries.map((q) => q.name)).toEqual(['weekly']);
    expect(u.exposures.map((n) => n.name)).toEqual(['board']);
    expect(u.dashboards.map((d) => d.slug)).toEqual(['a']);
    expect(u.usedByMetrics.map((n) => n.name)).toEqual(['revenue_per_order']);
    expect(usageCount(u)).toBe(4);
    expect(usageCount(metricUsage('revenue', null, null, catalog, []))).toBe(1);
  });

  it('keeps the health issues about the metric or its semantic models', () => {
    const issue = (object_type: SemanticIssue['object_type'], object_name: string): SemanticIssue => ({
      level: 'error', message: object_name, object_type, object_name, element_type: null, element_name: null,
    });
    const issues = [issue('metric', 'revenue'), issue('metric', 'other'), issue('semantic_model', 'sm_orders'), issue('semantic_model', 'sm_x')];
    expect(metricIssues(issues, 'revenue', ['sm_orders']).map((i) => i.message)).toEqual(['revenue', 'sm_orders']);
  });

  it('groups and searches the index', () => {
    const metrics = [
      metric('ratio', ['a', 'b'], { type: 'ratio' }), metric('z_rev', ['orders'], { label: 'Revenue' }),
      metric('count', ['orders']), metric('lonely', []), metric('users', ['customers'], { description: 'Active buyers' }),
    ];
    expect(groupMetrics(metrics).map(([g, list]) => [g, list.map((m) => m.name)])).toEqual([
      ['customers', ['users']], ['orders', ['count', 'z_rev']], ['Across models', ['ratio']], ['Other', ['lonely']],
    ]);
    expect(searchMetrics(metrics, 'revenue').map((m) => m.name)).toEqual(['z_rev']);
    expect(searchMetrics(metrics, 'BUYERS').map((m) => m.name)).toEqual(['users']);
    expect(searchMetrics(metrics, 'ratio').map((m) => m.name)).toEqual(['ratio']);
    expect(searchMetrics(metrics, ' ')).toHaveLength(5);
  });

  it('groups dimensions by entity, time last', () => {
    const m = metric('revenue', ['orders'], { dimensions: [
      { name: 'customer__region', type: 'categorical', time_granularity: null, label: null, description: null },
      { name: 'metric_time__day', type: 'time', time_granularity: 'day', label: null, description: null },
      { name: 'metric_time__month', type: 'time', time_granularity: 'month', label: null, description: null },
      { name: 'order__channel', type: 'categorical', time_granularity: null, label: null, description: null },
      { name: 'customer__tier', type: 'categorical', time_granularity: null, label: null, description: null },
    ] });
    expect(dimensionGroups(m)).toEqual([
      { entity: 'customer', names: ['customer__region', 'customer__tier'] },
      { entity: 'order', names: ['order__channel'] },
      { entity: 'time', names: ['metric_time'] },
    ]);
  });

  it('links to a metric page', () => {
    expect(metricPageSearch('revenue')).toBe('tab=explore&metric=revenue');
  });
});
