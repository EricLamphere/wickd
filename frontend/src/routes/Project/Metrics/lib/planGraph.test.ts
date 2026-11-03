import { describe, expect, it } from 'vitest';
import type { PlanNodeDto } from '../../../../lib/metricDebugApi';
import { layoutPlan, PLAN_NODE_W, sqlSpanFor, stepIndexFor } from './planGraph';

const node = (id: string, kind: PlanNodeDto['kind'], label: string, inputs: string[], step: number | null, over: Partial<PlanNodeDto> = {}): PlanNodeDto => ({
  id, kind, node_type: 'X', label, inputs, step, ...over,
});

// read (unmatched label) → metric time → aggregate (all in one SELECT, step 0)
const plan = [
  node('r', 'read', 'Read From SemanticModelDataSet(\'mart_sales\')', [], null, { semantic_model: 'mart_sales' }),
  node('t', 'metric_time', 'Metric Time Dimension \'order_date\'', ['r'], 0),
  node('a', 'aggregate', 'Aggregate Inputs for Simple Metrics', ['t'], 0),
];
const select = 'SELECT\n  AVG(x) AS avg_discount\nFROM sales\nGROUP BY 1';
const sql = `-- Read Elements From Semantic Model 'mart_sales'\n-- Metric Time Dimension 'order_date'\n-- Aggregate Inputs for Simple Metrics\n${select}`;
const steps = [{ index: 0, labels: ["Read Elements From Semantic Model 'mart_sales'", "Metric Time Dimension 'order_date'", 'Aggregate Inputs for Simple Metrics'],
  sql: `-- Read Elements From Semantic Model 'mart_sales'\n-- Metric Time Dimension 'order_date'\n-- Aggregate Inputs for Simple Metrics\n${select}` }];

describe('planGraph', () => {
  it('lays the plan out left to right', () => {
    const l = layoutPlan(plan);
    const x = Object.fromEntries(l.nodes.map((n) => [n.id, n.x]));
    expect(x.r).toBeLessThan(x.t);
    expect(x.t).toBeLessThan(x.a);
    expect(l.width).toBeGreaterThan(3 * PLAN_NODE_W);
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['r>t', 't>a']);
  });

  it('a merged step is written in the SELECT of the step it feeds', () => {
    expect(stepIndexFor(plan, 'r')).toBe(0);
    expect(stepIndexFor([node('x', 'read', 'X', [], null)], 'x')).toBeNull();
  });

  it("highlights the step's SELECT and marks its own comment line", () => {
    expect(sqlSpanFor({ sql, steps, plan }, 't')).toMatchObject({ start: 1, end: 7, ranges: [[1, 7]], focus: 2 });
    expect(sqlSpanFor({ sql, steps, plan }, 'r')).toMatchObject({ start: 1, end: 7, ranges: [[1, 7]], focus: 1 });
    expect(sqlSpanFor({ sql: 'select 1', steps, plan }, 't')).toBeNull();
  });

  it("leaves out the other steps' SELECTs nested inside a step", () => {
    const inner = "SELECT\n  x\nFROM sales";
    const outer = `SELECT\n  SUM(x)\nFROM (\n  -- Read Elements From Semantic Model 'mart_sales'\n  ${inner.replace(/\n/g, '\n  ')}\n) s`;
    const full = `-- Aggregate Inputs for Simple Metrics\n${outer}`;
    const nested = [
      { index: 0, labels: ["Read Elements From Semantic Model 'mart_sales'"], sql: `-- Read Elements From Semantic Model 'mart_sales'\n${inner.replace(/\n/g, '\n  ')}` },
      { index: 1, labels: ['Aggregate Inputs for Simple Metrics'], sql: `-- Aggregate Inputs for Simple Metrics\n${outer}` },
    ];
    const p2 = [
      node('r', 'read', 'x', [], 0, { semantic_model: 'mart_sales' }),
      node('a', 'aggregate', 'Aggregate Inputs for Simple Metrics', ['r'], 1),
    ];
    // lines: 1 comment, 2 SELECT, 3 SUM, 4 FROM (, 5 -- Read, 6 SELECT, 7 x, 8 FROM sales, 9 ) s
    expect(sqlSpanFor({ sql: full, steps: nested, plan: p2 }, 'a')).toMatchObject({ start: 1, end: 9, ranges: [[1, 4], [9, 9]], focus: 1 });
    expect(sqlSpanFor({ sql: full, steps: nested, plan: p2 }, 'r')).toMatchObject({ start: 5, end: 8, ranges: [[5, 8]] });
  });
});
