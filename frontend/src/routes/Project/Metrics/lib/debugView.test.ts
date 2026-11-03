import { describe, expect, it } from 'vitest';
import type { DebugResultDto, FindingDto, PlanNodeDto } from '../../../../lib/metricDebugApi';
import { conclusion, costNote, worstFirst, defaultStep, describeNode, hasNotRun, pipeline, stepPurpose, stepSummary, worstStatus } from './debugView';

const node = (over: Partial<PlanNodeDto>): PlanNodeDto => ({
  id: 'n', kind: 'other', node_type: 'X', label: 'X', inputs: [], step: null, ...over,
});
const finding = (over: Partial<FindingDto>): FindingDto => ({
  id: 'f', kind: 'input', check: 'rows', node: null, status: 'ok', title: '', value: '', detail: '', sql: null, data: {}, ...over,
});

const RESULT: DebugResultDto = {
  sql: 'select 1', columns: ['metric_time__month', 'customer__region', 'revenue'], plan_error: null,
  plan: [
    node({ id: 'r1', kind: 'read', semantic_model: 'orders' }),
    node({ id: 'r2', kind: 'read', semantic_model: 'customers' }),
    node({ id: 'j', kind: 'join', inputs: ['r1', 'r2'], step: 0, left_models: ['orders'],
      targets: [{ entity: 'customer', join_type: 'left_outer', semantic_models: ['customers'] }] }),
    node({ id: 'a', kind: 'aggregate', inputs: ['j'], metrics: ['revenue'], step: 1 }),
  ],
  steps: [{ index: 0, labels: ['Join Standard Outputs'], sql: 'select a' }, { index: 1, labels: ['Aggregate'], sql: 'select b' }],
  checks: [
    finding({ id: 'input:0:rows', node: 'r1', status: 'ok' }),
    finding({ id: 'input:0:nulls', node: 'r1', status: 'warn' }),
    finding({ id: 'join:0:fanout', kind: 'join', node: 'j', status: 'fail' }),
    finding({ id: 'x', node: 'gone', status: 'info' }),
  ],
  warnings: [], notes: [], queries: 3, ran: 3, ran_at: null, inputs: [], group_by: [], models: {},
};

describe('debugView', () => {
  it('groups checks under their steps with the worst status', () => {
    const { steps, unplaced } = pipeline(RESULT);
    expect(steps.map((s) => [s.node.id, s.status])).toEqual([['r1', 'warn'], ['r2', null], ['j', 'fail'], ['a', null]]);
    expect(steps[2].sql?.sql).toBe('select a');
    expect(steps[2].from).toEqual(['Read orders', 'Read customers']);
    expect(unplaced.map((f) => f.id)).toEqual(['x']);
  });

  it('ranks statuses', () => {
    expect(worstStatus([finding({ status: 'info' }), finding({ status: 'error' }), finding({ status: 'warn' })])).toBe('error');
    expect(worstStatus([])).toBeNull();
  });

  it('describes steps in one line', () => {
    expect(describeNode(RESULT.plan[2])).toBe('orders → customers on customer (left outer)');
    expect(describeNode(node({ kind: 'constrain_time', time_range: { start: '2026-01-01 00:00:00', end: null } }))).toBe('2026-01-01 → …');
    expect(describeNode(node({ kind: 'filter', filters: ["a = 'x'", 'b > 1'] }))).toBe("a = 'x' AND b > 1");
    expect(describeNode(node({ kind: 'join_over_time' }))).toBe('all time');
  });

  it('picks the first flagged step', () => {
    const { steps } = pipeline(RESULT);
    expect(defaultStep(steps)).toBe('r1');
    expect(defaultStep(steps.map((s) => ({ ...s, status: null })))).toBe('a');
    expect(defaultStep([])).toBeNull();
  });

  it('notes the cost and stored results', () => {
    expect(costNote(RESULT)).toBe('3 check queries · 3 ran on the warehouse just now');
    expect(costNote({ ...RESULT, queries: 1, ran: 0 })).toBe('1 check query · stored results');
    expect(hasNotRun({ ...RESULT, checks: [finding({ status: 'not_run' })] })).toBe(true);
    expect(hasNotRun(undefined)).toBe(false);
  });
});

describe('step wording', () => {
  it('says what each step does in one line, with its specifics', () => {
    expect(stepSummary(node({ kind: 'read', semantic_model: 'mart_sales' }))).toBe('Reads mart_sales');
    expect(stepSummary(node({ kind: 'metric_time', agg_time_dimension: 'order_date' }))).toBe('Uses order_date as the time');
    expect(stepSummary(node({ kind: 'constrain_time', time_range: { start: '2026-10-04T00:00:00', end: '2026-11-02' } })))
      .toBe('Keeps 2026-10-04 → 2026-11-02');
    expect(stepSummary(node({ kind: 'filter', filters: ["status = 'paid'"] }))).toBe("Keeps rows where status = 'paid'");
    expect(stepSummary(node({ kind: 'compute', metrics: ['avg_discount'] }))).toBe('Computes avg_discount');
    expect(stepSummary(node({ kind: 'other', label: 'Something' }))).toBe('Something');
  });

  it('explains every known step kind', () => {
    for (const kind of ['read', 'metric_time', 'join', 'filter', 'constrain_time', 'aggregate', 'compute', 'combine'] as const) {
      expect(stepPurpose(node({ kind, semantic_model: 'm', agg_time_dimension: 'd', metrics: ['x'] })).length).toBeGreaterThan(20);
    }
    expect(stepPurpose(node({ kind: 'metric_time', agg_time_dimension: 'order_date' }))).toContain('order_date');
  });
});

describe('conclusion', () => {
  const coverage = (status: FindingDto['status'], data: Record<string, unknown>) =>
    finding({ check: 'time', status, title: 'order_date coverage', data: { semantic_model: 'mart_sales', agg_time_dimension: 'order_date', ...data } });

  it('turns data that ends early into what it means and a fix', () => {
    const c = conclusion(coverage('warn', { min: '2023-01-01', max: '2026-10-28', start: '2026-10-04', end: '2026-11-02' }));
    expect(c.headline).toBe('Data ends Oct 28, 2026: the last 5 days of your period are empty.');
    expect(c.advice).toContain('mart_sales');
    expect(c.action).toEqual({ label: 'End the period on Oct 28', range: { start: '2026-10-04', end: '2026-10-28' } });
  });

  it('data that starts late, and a period with no data at all', () => {
    const late = conclusion(coverage('warn', { min: '2026-10-10', max: '2026-11-30', start: '2026-10-04', end: '2026-11-02' }));
    expect(late.headline).toBe('Data starts Oct 10, 2026: the first 6 days of your period are empty.');
    expect(late.action?.range).toEqual({ start: '2026-10-10', end: '2026-11-02' });
    const none = conclusion(coverage('fail', { min: '2023-01-01', max: '2024-06-30', start: '2026-10-04', end: '2026-11-02' }));
    expect(none.headline).toBe('No data in your period: mart_sales has data from Jan 1, 2023 to Jun 30, 2024.');
    expect(none.action).toEqual({ label: 'Show its last 30 days of data', range: { start: '2024-06-01', end: '2024-06-30' } });
  });

  it('any other problem reads as its title and detail', () => {
    const c = conclusion(finding({ check: 'fanout', status: 'warn', title: 'Join fan-out', detail: 'Rows double.' }));
    expect(c).toEqual({ headline: 'Join fan-out', advice: 'Rows double.', action: null });
  });
});

describe('worstFirst', () => {
  it('orders failures, then warnings, then the rest', () => {
    expect((['ok', null, 'warn', 'fail'] as const).slice().sort(worstFirst)).toEqual(['fail', 'warn', 'ok', null]);
  });
});
