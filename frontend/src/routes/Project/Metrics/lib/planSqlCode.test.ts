import { describe, expect, it } from 'vitest';
import type { PlanNodeDto } from '../../../../lib/metricDebugApi';
import { sqlSpanFor } from './planGraph';

const node = (id: string, kind: PlanNodeDto['kind'], label: string, inputs: string[], step: number | null, over: Partial<PlanNodeDto> = {}): PlanNodeDto => ({
  id, kind, node_type: 'X', label, inputs, step, ...over,
});

/** `sql` and its steps the way the backend splits them: each commented SELECT up to its closing paren. */
function split(sql: string, selects: { from: string; to: string; labels: string[] }[]) {
  return selects.map((s, index) => {
    const a = sql.indexOf(s.from);
    const b = sql.indexOf(s.to, a) + s.to.length;
    return { index, labels: s.labels, sql: `${s.labels.map((l) => `-- ${l}`).join('\n')}\n${sql.slice(a, b)}` };
  });
}

// average_order_value = revenue / orders: one inner SELECT for read → time → range → aggregate → compute, an outer one for the ratio
const RATIO = [
  '-- Compute Metrics via Expressions', //                                                    1
  '-- Write to DataTable', //                                                                 2
  'SELECT', //                                                                                3
  '  metric_time__day', //                                                                    4
  '  , CAST(revenue AS DOUBLE) / CAST(NULLIF(orders, 0) AS DOUBLE) AS average_order_value', // 5
  'FROM (', //                                                                                6
  "  -- Read Elements From Semantic Model 'orders'", //                                       7
  "  -- Metric Time Dimension 'order_date'", //                                               8
  '  -- Constrain Time Range to [2026-10-04T00:00:00, 2026-11-02T00:00:00]', //               9
  '  -- Aggregate Inputs for Simple Metrics', //                                              10
  '  -- Compute Metrics via Expressions', //                                                  11
  '  SELECT', //                                                                              12
  "    DATE_TRUNC('day', order_date) AS metric_time__day", //                                 13
  '    , SUM(net_amount_dollars) AS revenue', //                                              14
  '    , COUNT(DISTINCT order_id) AS orders', //                                              15
  '  FROM "dev"."main_silver"."int_sales_enriched" orders_src_10000', //                      16
  "  WHERE DATE_TRUNC('day', order_date) BETWEEN '2026-10-04' AND '2026-11-02'", //           17
  '  GROUP BY', //                                                                            18
  "    DATE_TRUNC('day', order_date)", //                                                     19
  ') subq_6', //                                                                              20
].join('\n');
const ratioSteps = split(RATIO, [
  { from: 'SELECT\n    DATE_TRUNC', to: "GROUP BY\n    DATE_TRUNC('day', order_date)",
    labels: ["Read Elements From Semantic Model 'orders'", "Metric Time Dimension 'order_date'",
      'Constrain Time Range to [2026-10-04T00:00:00, 2026-11-02T00:00:00]', 'Aggregate Inputs for Simple Metrics', 'Compute Metrics via Expressions'] },
  { from: 'SELECT\n  metric_time__day', to: ') subq_6', labels: ['Compute Metrics via Expressions', 'Write to DataTable'] },
]);
const ratioPlan = [
  node('r', 'read', "Read From SemanticModelDataSet('orders')", [], null, { semantic_model: 'orders' }),
  node('t', 'metric_time', "Metric Time Dimension 'order_date'", ['r'], 0, { agg_time_dimension: 'order_date' }),
  node('c', 'constrain_time', 'Constrain Time Range to [2026-10-04T00:00:00, 2026-11-02T00:00:00]', ['t'], 0,
    { time_range: { start: '2026-10-04T00:00:00', end: '2026-11-02T00:00:00' } }),
  node('a', 'aggregate', 'Aggregate Inputs for Simple Metrics', ['c'], 0),
  node('m1', 'compute', 'Compute Metrics via Expressions', ['a'], 0, { metrics: ['revenue', 'orders'] }),
  node('m2', 'compute', 'Compute Metrics via Expressions', ['m1'], 1, { metrics: ['average_order_value'] }),
];
const models = { orders: { relation: '"dev"."main_silver"."int_sales_enriched"', entities: [], dimensions: [] } };
const ratio = { sql: RATIO, steps: ratioSteps, plan: ratioPlan, models };

describe('highlighting the code of a step', () => {
  it('points each step of a merged SELECT at its own lines', () => {
    expect(sqlSpanFor(ratio, 'r')?.code).toEqual([16]);
    expect(sqlSpanFor(ratio, 't')?.code).toEqual([13]);
    expect(sqlSpanFor(ratio, 'c')?.code).toEqual([17]);
    expect(sqlSpanFor(ratio, 'a')?.code).toEqual([14, 15, 18, 19]);
    expect(sqlSpanFor(ratio, 'm1')?.code).toEqual([14, 15]);
  });

  it('metric time without a metric_time column: the lines using its date column', () => {
    const sql = RATIO.replace('AS metric_time__day', 'AS order_day');
    const steps = ratioSteps.map((st) => ({ ...st, sql: st.sql.replace('AS metric_time__day', 'AS order_day') }));
    expect(sqlSpanFor({ ...ratio, sql, steps }, 't')?.code).toEqual([13, 17]);
  });

  it("the ratio's own compute is in the outer SELECT, not the nested one", () => {
    expect(sqlSpanFor(ratio, 'm2')?.code).toEqual([5]);
  });

  it('finds nothing → no code lines, so the view falls back to the comment line', () => {
    const noModels = { ...ratio, models: {} };
    expect(sqlSpanFor(noModels, 'r')?.code).toEqual([16]); // the only plain FROM in the SELECT
    const odd = node('x', 'other', 'Something MetricFlow added', ['m1'], 0);
    expect(sqlSpanFor({ ...ratio, plan: [...ratioPlan, odd] }, 'x')?.code).toEqual([]);
  });

  const JOIN = [
    '-- Join Standard Outputs', //                                                              1
    '-- Aggregate Inputs for Simple Metrics', //                                                2
    'SELECT', //                                                                                3
    '  customers_src_10000.country AS customer__country', //                                    4
    '  , SUM(subq_2.__revenue) AS revenue', //                                                  5
    'FROM (', //                                                                                6
    "  -- Read Elements From Semantic Model 'orders'", //                                       7
    '  SELECT', //                                                                              8
    '    customer_id AS customer', //                                                           9
    '  FROM "dev"."main"."orders" orders_src_10000', //                                         10
    ') subq_2', //                                                                              11
    'LEFT OUTER JOIN', //                                                                       12
    '  "dev"."main"."customers" customers_src_10000', //                                        13
    'ON', //                                                                                    14
    '  subq_2.customer = customers_src_10000.customer_id', //                                   15
    "WHERE customers_src_10000.country = 'US'", //                                              16
    'GROUP BY', //                                                                              17
    '  customers_src_10000.country', //                                                         18
  ].join('\n');
  const joinSteps = split(JOIN, [
    { from: 'SELECT\n    customer_id', to: 'orders_src_10000', labels: ["Read Elements From Semantic Model 'orders'"] },
    { from: 'SELECT\n  customers_src', to: '  customers_src_10000.country', labels: ['Join Standard Outputs', 'Aggregate Inputs for Simple Metrics'] },
  ]);
  joinSteps[1].sql = `-- Join Standard Outputs\n-- Aggregate Inputs for Simple Metrics\n${JOIN.slice(JOIN.indexOf('SELECT\n  customers_src'))}`;
  const joinPlan = [
    node('ro', 'read', "Read From SemanticModelDataSet('orders')", [], 0, { semantic_model: 'orders' }),
    node('rc', 'read', "Read From SemanticModelDataSet('customers')", [], null, { semantic_model: 'customers' }),
    node('j', 'join', 'Join Standard Outputs', ['ro', 'rc'], 1),
    node('f', 'filter', 'Pass Only Elements', ['j'], 1, { filters: ["{{ Dimension('customer__country') }} = 'US'"] }),
    node('a', 'aggregate', 'Aggregate Inputs for Simple Metrics', ['f'], 1),
  ];
  const join = { sql: JOIN, steps: joinSteps, plan: joinPlan,
    models: { orders: { relation: '"dev"."main"."orders"', entities: [], dimensions: [] }, customers: { relation: '"dev"."main"."customers"', entities: [], dimensions: [] } } };

  it('a join: its JOIN and ON lines; the joined table is the read; the WHERE is the filter', () => {
    expect(sqlSpanFor(join, 'j')?.code).toEqual([12, 13, 14, 15]);
    expect(sqlSpanFor(join, 'rc')?.code).toEqual([13]);
    expect(sqlSpanFor(join, 'ro')?.code).toEqual([10]);
    expect(sqlSpanFor(join, 'f')?.code).toEqual([16]);
    expect(sqlSpanFor(join, 'a')?.code).toEqual([5, 17, 18]);
  });
});
