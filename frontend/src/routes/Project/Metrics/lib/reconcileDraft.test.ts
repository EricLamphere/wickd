import { describe, expect, it } from 'vitest';
import type { DebugInputDto, DebugResultDto } from '../../../../lib/metricDebugApi';
import { hasPlaceholders, reconcileDraft, withoutJinja } from './reconcileDraft';

const input = (over: Partial<DebugInputDto>): DebugInputDto => ({
  metric: 'revenue', via: 'revenue', semantic_model: 'orders', expr: 'amount', agg: 'sum',
  agg_time_dimension: 'order_date', filters: [], filter_sql: '', ...over,
});
const simple = { type: 'simple', expr: null, filters: [], inputs: [] };

const RESULT = {
  columns: ['metric_time__month', 'customer__region', 'revenue'],
  inputs: [input({ filters: ["{{ Dimension('order__status') }} = 'completed'"], filter_sql: "((status) = 'completed')" })],
  metric_defs: { revenue: simple },
  group_by: [
    { name: 'metric_time__month', kind: 'metric_time', element: 'metric_time', entity_links: [] },
    { name: 'customer__region', kind: 'dimension', element: 'region', entity_links: ['customer'], semantic_model: 'customers', expr: 'region' },
  ],
  models: {
    orders: { relation: '"dev"."main"."orders"', entities: [], dimensions: [{ name: 'order_date', type: 'time', expr: 'ordered_at' }] },
  },
} as unknown as DebugResultDto;

const noJinja = (sql: string) => expect(sql).not.toMatch(/\{\{|\}\}|\{%/);

describe('reconcileDraft', () => {
  it('writes a simple metric with its filter applied', () => {
    const sql = reconcileDraft({ metrics: ['revenue'], start: '2026-01-01', end: '2026-03-31' }, RESULT);
    noJinja(sql);
    expect(sql).toContain("  date_trunc('month', ordered_at) as metric_time__month");
    expect(sql).toContain('  , … /* customer__region: from customers, join it in */ as customer__region');
    expect(sql).toContain("  , sum(case when ((status) = 'completed') then amount end) as revenue\nfrom \"dev\".\"main\".\"orders\"");
    expect(sql).toContain("where ordered_at >= '2026-01-01'\n  and ordered_at <= '2026-03-31'");
    expect(sql.endsWith('group by 1, 2')).toBe(true);
  });

  it('writes ratio metrics as a complete, runnable query', () => {
    const result = {
      ...RESULT, columns: ['metric_time__day', 'aov'],
      group_by: [{ name: 'metric_time__day', kind: 'metric_time', element: 'metric_time', entity_links: [] }],
      inputs: [input({ via: 'aov' }), input({ metric: 'orders', via: 'aov', expr: 'order_id', agg: 'count' })],
      metric_defs: {
        aov: { type: 'ratio', expr: null, filters: [], inputs: [
          { role: 'numerator', name: 'revenue', alias: null, filters: [], offset: false },
          { role: 'denominator', name: 'orders', alias: null, filters: [], offset: false }] },
        revenue: simple, orders: simple,
      },
    } as unknown as DebugResultDto;
    const sql = reconcileDraft({ metrics: ['aov'] }, result);
    expect(sql).toBe([
      '-- aov written by hand from orders, without MetricFlow.',
      'select',
      "  date_trunc('day', ordered_at) as metric_time__day",
      '  , 1.0 * sum(amount) / nullif(count(order_id), 0) as aov',
      'from "dev"."main"."orders"',
      'group by 1',
    ].join('\n'));
    expect(hasPlaceholders(sql)).toBe(false);
  });

  it('substitutes derived metric inputs by name or alias', () => {
    const result = {
      ...RESULT, columns: ['rpb'], group_by: [],
      inputs: [input({ via: 'rpb' }), input({ metric: 'buyers', via: 'rpb', expr: 'customer_id', agg: 'count_distinct' })],
      metric_defs: {
        rpb: { type: 'derived', expr: 'rev / buyers', filters: [], inputs: [
          { role: 'input', name: 'revenue', alias: 'rev', filters: [], offset: false },
          { role: 'input', name: 'buyers', alias: null, filters: [], offset: false }] },
        revenue: simple, buyers: simple,
      },
    } as unknown as DebugResultDto;
    expect(reconcileDraft({ metrics: ['rpb'] }, result)).toContain('  (sum(amount)) / (count(distinct customer_id)) as rpb\nfrom');
  });

  it('falls back to a skeleton it refuses to run for what it cannot write', () => {
    const offset = {
      ...RESULT, columns: ['growth'], group_by: [],
      metric_defs: { growth: { type: 'derived', expr: 'revenue - last', filters: [], inputs: [
        { role: 'input', name: 'revenue', alias: 'last', filters: [], offset: true }] }, revenue: simple },
    } as unknown as DebugResultDto;
    const sql = reconcileDraft({ metrics: ['growth'] }, offset);
    noJinja(sql);
    expect(sql).toContain("Couldn't write it for you (growth uses an offset)");
    expect(hasPlaceholders(sql)).toBe(true);
    expect(reconcileDraft({ metrics: ['revenue'], group_by: ['metric_time__day'] }, undefined)).toContain('the checks haven\'t loaded yet');
  });

  it('only counts placeholders outside comments', () => {
    expect(hasPlaceholders('-- replace each … with SQL\nselect 1')).toBe(false);
    expect(hasPlaceholders('select … as a')).toBe(true);
  });

  it('strips templates and stray braces', () => {
    expect(withoutJinja("{{ TimeDimension('metric_time', 'day') }} >= '2026-01-01'")).toBe("metric_time >= '2026-01-01'");
    expect(withoutJinja('{% if x %}a{% endif %}')).toBe(' if x a endif ');
  });
});
