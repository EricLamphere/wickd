// Debug tab (plan 15): pure helpers over POST /semantic/debug — the plan as a pipeline of
// steps with their checks, worst status per step, one-line step descriptions, the cost note
// and the query key. Unit-tested in debugView.test.ts (the reconcile starter: reconcileDraft.ts).
import type { DebugResultDto, FindingDto, FindingStatus, PlanNodeDto, SqlStepDto } from '../../../../lib/metricDebugApi';
import type { MetricQueryBody } from '../../../../lib/semanticApi';

const SEVERITY: Record<FindingStatus, number> = { fail: 0, error: 1, warn: 2, not_run: 3, info: 4, skipped: 5, ok: 6 };

export const KIND_LABELS: Record<string, string> = {
  read: 'Read', metric_time: 'Metric time', join: 'Join', filter: 'Filter', constrain_time: 'Time range',
  aggregate: 'Aggregate', compute: 'Compute', combine: 'Combine', join_over_time: 'Cumulative window',
  join_time_spine: 'Time spine', join_conversion: 'Conversion join', semi_additive: 'Semi-additive',
  order_limit: 'Order & limit', min_max: 'Min / max', window: 'Window', custom_granularity: 'Custom grain', other: 'Step',
};

export function worstStatus(findings: readonly FindingDto[]): FindingStatus | null {
  let worst: FindingStatus | null = null;
  for (const f of findings) if (worst === null || SEVERITY[f.status] < SEVERITY[worst]) worst = f.status;
  return worst;
}

/** Sort order for statuses: the worst first (no status last). */
export function worstFirst(a: FindingStatus | null, b: FindingStatus | null): number {
  return (a === null ? 99 : SEVERITY[a]) - (b === null ? 99 : SEVERITY[b]);
}

export function isProblem(status: FindingStatus | null): boolean {
  return status === 'fail' || status === 'error' || status === 'warn';
}

export interface PipelineStep {
  node: PlanNodeDto;
  findings: FindingDto[];
  status: FindingStatus | null;
  sql: SqlStepDto | null;
  /** labels of the steps feeding this one, when more than one does (joins, combines) */
  from: string[];
}

function shortLabel(node: PlanNodeDto | undefined): string {
  if (!node) return '?';
  return node.semantic_model ? `${KIND_LABELS[node.kind]} ${node.semantic_model}` : KIND_LABELS[node.kind] ?? node.kind;
}

/** The plan sources first, each step with its checks; checks whose step isn't in the plan go last. */
export function pipeline(result: DebugResultDto): { steps: PipelineStep[]; unplaced: FindingDto[] } {
  const byNode = new Map<string, FindingDto[]>();
  for (const f of result.checks) {
    if (!f.node) continue;
    byNode.set(f.node, [...(byNode.get(f.node) ?? []), f]);
  }
  const nodes = new Map(result.plan.map((n) => [n.id, n]));
  const steps = result.plan.map((node): PipelineStep => {
    const findings = byNode.get(node.id) ?? [];
    return {
      node, findings, status: worstStatus(findings),
      sql: node.step !== null && node.step !== undefined ? result.steps[node.step] ?? null : null,
      from: node.inputs.length > 1 ? node.inputs.map((i) => shortLabel(nodes.get(i))) : [],
    };
  });
  const unplaced = result.checks.filter((f) => !f.node || !nodes.has(f.node));
  return { steps, unplaced };
}

function range(r: { start: string | null; end: string | null } | null | undefined): string {
  if (!r) return '';
  const day = (s: string | null) => (s ? s.slice(0, 10) : '…');
  return `${day(r.start)} → ${day(r.end)}`;
}

function joinType(t: string | null | undefined): string {
  return t ? t.replace(/_/g, ' ') : '';
}

/** One line under the step's name. */
export function describeNode(node: PlanNodeDto): string {
  switch (node.kind) {
    case 'read': return node.semantic_model ?? '';
    case 'metric_time': return node.agg_time_dimension ? `metric_time = ${node.agg_time_dimension}` : '';
    case 'join':
      return (node.targets ?? []).map((t) => {
        const via = t.entity ? ` on ${t.entity}` : '';
        const type = joinType(t.join_type);
        return `${(node.left_models ?? []).join(', ')} → ${t.semantic_models.join(', ')}${via}${type ? ` (${type})` : ''}`;
      }).join('; ');
    case 'filter': return (node.filters ?? []).join(' AND ');
    case 'constrain_time': return range(node.time_range);
    case 'join_over_time': return [node.window ? `window ${node.window}` : '', node.grain_to_date ? `${node.grain_to_date} to date` : '',
      range(node.time_range)].filter(Boolean).join(' · ') || 'all time';
    case 'aggregate': case 'compute': return (node.metrics ?? []).join(', ');
    case 'combine': case 'join_time_spine': return joinType(node.join_type);
    case 'order_limit': return node.limit != null ? `limit ${node.limit}` : '';
    default: return node.label;
  }
}

/** A step in a few words with its specifics, under its name in the pipeline. */
export function stepSummary(node: PlanNodeDto): string {
  switch (node.kind) {
    case 'read': return node.semantic_model ? `Reads ${node.semantic_model}` : 'Reads the table';
    case 'metric_time': return node.agg_time_dimension ? `Uses ${node.agg_time_dimension} as the time` : 'Picks the time column';
    case 'join': return `Adds ${describeNode(node)}`;
    case 'filter': return node.filters?.length ? `Keeps rows where ${node.filters.join(' AND ')}` : 'Filters rows';
    case 'constrain_time': return node.time_range ? `Keeps ${range(node.time_range)}` : 'Keeps your period';
    case 'aggregate': return 'Aggregates the measures';
    case 'compute': return node.metrics?.length ? `Computes ${node.metrics.join(', ')}` : 'Computes the metric';
    default: return describeNode(node) || node.label;
  }
}

/** What a step does and why it matters, at the top of its detail. */
export function stepPurpose(node: PlanNodeDto): string {
  const model = node.semantic_model ?? 'the semantic model';
  switch (node.kind) {
    case 'read': return `Reads the rows of ${model}'s table. Everything after works on these rows, so missing or empty data shows up here first.`;
    case 'metric_time': return `Uses ${node.agg_time_dimension ?? 'its default time dimension'} as the metric's time (metric_time): the date every period, grain and time filter applies to.`;
    case 'join': return 'Joins other semantic models to bring in the dimensions you grouped or filtered by. A join can multiply rows (double counting) or drop rows that don\'t match.';
    case 'filter': return 'Keeps only the rows matching the metric\'s filter and yours; everything else is left out of the number.';
    case 'constrain_time': return 'Keeps only the rows whose metric time falls in your period.';
    case 'aggregate': return 'Aggregates the measures (sum, count, average…) for each group: each period, and each value of what you split by.';
    case 'compute': return 'Turns the aggregated measures into the metric: the same value for a simple metric, the formula for ratios and derived metrics.';
    case 'combine': return 'Puts the results of the metric\'s inputs side by side so a ratio or derived formula can use them together.';
    case 'join_over_time': return 'Adds up values over a window for a cumulative metric, so each period includes the ones before it.';
    case 'join_time_spine': return 'Joins the time spine so periods with no data still appear.';
    case 'order_limit': return 'Sorts the rows and keeps the first ones.';
    default: return `MetricFlow's ${node.label} step.`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

function utcDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `2026-10-28` → `Oct 28, 2026` (or `Oct 28` without the year). */
function dayLabel(iso: string, year = true): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${year ? `, ${y}` : ''}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export interface Conclusion {
  headline: string;
  advice: string;
  /** a fix the panel can apply: the query's period set to `range` */
  action: { label: string; range: { start: string; end: string } } | null;
}

const LAST_DAYS = 30;

/** A problem as what it means for the number and what to do; time coverage gets a period fix. */
export function conclusion(f: FindingDto): Conclusion {
  const d = f.data as Record<string, string | undefined>;
  const min = d.min?.slice(0, 10);
  const max = d.max?.slice(0, 10);
  const start = d.start?.slice(0, 10);
  const end = d.end?.slice(0, 10);
  if (f.check !== 'time' || !min || !max) return { headline: f.title, advice: f.detail, action: null };
  const model = d.semantic_model ?? 'the table';
  const rebuild = `Rebuild ${model} (or check that its sources are up to date), or change the period.`;
  if (f.status === 'fail') {
    return {
      headline: `No data in your period: ${model} has data from ${dayLabel(min)} to ${dayLabel(max)}.`,
      advice: rebuild,
      action: { label: `Show its last ${LAST_DAYS} days of data`, range: { start: isoDay(utcDay(max) - (LAST_DAYS - 1) * DAY_MS), end: max } },
    };
  }
  const endsEarly = !!end && end > max;
  const startsLate = !!start && start < min;
  const daysAfter = endsEarly ? Math.round((utcDay(end!) - utcDay(max)) / DAY_MS) : 0;
  const daysBefore = startsLate ? Math.round((utcDay(min) - utcDay(start!)) / DAY_MS) : 0;
  if (endsEarly && startsLate) {
    return {
      headline: `Data only covers ${dayLabel(min)} to ${dayLabel(max)}: ${plural(daysBefore + daysAfter, 'day')} of your period are empty.`,
      advice: rebuild,
      action: { label: `Use ${dayLabel(min, false)} → ${dayLabel(max, false)}`, range: { start: min, end: max } },
    };
  }
  if (endsEarly) {
    return {
      headline: `Data ends ${dayLabel(max)}: the last ${plural(daysAfter, 'day')} of your period ${daysAfter === 1 ? 'is' : 'are'} empty.`,
      advice: `A drop at the end of the chart is missing data, not a real change. ${rebuild}`,
      action: start ? { label: `End the period on ${dayLabel(max, false)}`, range: { start, end: max } } : null,
    };
  }
  if (startsLate) {
    return {
      headline: `Data starts ${dayLabel(min)}: the first ${plural(daysBefore, 'day')} of your period ${daysBefore === 1 ? 'is' : 'are'} empty.`,
      advice: `Low values at the start of the chart are missing data, not a real change. ${rebuild}`,
      action: end ? { label: `Start the period on ${dayLabel(min, false)}`, range: { start: min, end } } : null,
    };
  }
  return { headline: f.title, advice: f.detail, action: null };
}

export function costNote(result: DebugResultDto): string {
  const n = result.queries;
  const base = `${n} check ${n === 1 ? 'query' : 'queries'}`;
  if (result.ran > 0) return `${base} · ${result.ran} ran on the warehouse just now`;
  return `${base} · stored results`;
}

export function hasNotRun(result: DebugResultDto | undefined): boolean {
  return !!result?.checks.some((c) => c.status === 'not_run');
}

/** The step to show when nothing is picked: the first with a problem, else the last. */
export function defaultStep(steps: readonly PipelineStep[]): string | null {
  const flagged = steps.find((s) => isProblem(s.status));
  return (flagged ?? steps[steps.length - 1])?.node.id ?? null;
}

export function debugQueryKey(projectId: number, body: MetricQueryBody | null): readonly unknown[] {
  return ['metric-debug', projectId, body ? JSON.stringify(body) : null];
}
