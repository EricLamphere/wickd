// Drilling into a value (plan 12 follow-up): clicking a bar, a Top N row or (right-click) a
// table row splits the widget and shows its metrics over time for that value, using the query
// the widget ran (so its period, comparison and filters carry over). Pure; tested in drill.test.ts.
import type { WidgetResultDto } from '../../../../lib/dashboardsApi';
import type { MetricQueryBody } from '../../../../lib/semanticApi';
import { categories, changeRatio, filterFor } from './dashboardModel';
import { toNumber } from '../lib/metricSeries';

/** The value(s) picked: one dimension for a bar or Top N row, every dimension of a table row. */
export interface Pick {
  values: { dimension: string; value: string }[];
}

export function pickLabel(pick: Pick): string {
  return pick.values.map((v) => (v.value === '∅' ? '(empty)' : v.value)).join(' · ');
}

export function pickKey(pick: Pick): string {
  return pick.values.map((v) => `${v.dimension}=${v.value}`).join('&');
}

export function pickFilters(pick: Pick): string[] {
  return pick.values.map((v) => filterFor(v.dimension, v.value));
}

/** The widget's query narrowed to the pick and grouped over time (no ordering or limit). */
export function drillQuery(ran: MetricQueryBody, pick: Pick, grain: string): MetricQueryBody {
  const body: MetricQueryBody = { metrics: ran.metrics ?? [], group_by: [`metric_time__${grain}`], where: [...(ran.where ?? []), ...pickFilters(pick)] };
  if (ran.start) body.start = ran.start;
  if (ran.end) body.end = ran.end;
  return body;
}

/** The drill queries for a widget's result: the current period, and the previous one when compared. */
export function drillBodies(result: WidgetResultDto, pick: Pick): { current: MetricQueryBody; previous: MetricQueryBody | null } | null {
  const current = result.queries.current;
  if (!current) return null;
  const grain = result.grain ?? 'day';
  const previous = result.queries.current_previous;
  return {
    current: drillQuery(current.query, pick, grain),
    previous: previous ? drillQuery(previous.query, pick, grain) : null,
  };
}

export interface PickStats {
  value: number | null;
  previous: number | null;
  change: number | null;
  /** share of the total over the values shown (null for ratios we can't add up honestly: tables) */
  share: number | null;
}

/** The pick's value for `metric` in the widget's result, the previous one and the change. */
export function pickStats(result: WidgetResultDto, pick: Pick, metric: string): PickStats | null {
  const cur = result.queries.current;
  if (!cur || cur.status !== 'ok') return null;
  const prev = result.queries.current_previous?.status === 'ok' ? result.queries.current_previous : null;
  if (pick.values.length === 1) {
    const { dimension, value } = pick.values[0];
    const cats = categories(cur, prev, dimension, metric);
    const hit = cats.find((c) => c.key === value);
    if (!hit) return null;
    const total = cats.reduce((sum, c) => sum + (c.value ?? 0), 0);
    return { value: hit.value, previous: hit.previous, change: changeRatio(hit.value, hit.previous), share: total && hit.value !== null ? hit.value / total : null };
  }
  const match = (columns: string[], row: unknown[]) => pick.values.every((v) => String(row[columns.indexOf(v.dimension)] ?? '∅') === v.value);
  const row = cur.rows.find((r) => match(cur.columns, r));
  if (!row) return null;
  const value = toNumber(row[cur.columns.indexOf(metric)]);
  const before = prev ? prev.rows.find((r) => match(prev.columns, r)) : undefined;
  const previous = before && prev ? toNumber(before[prev.columns.indexOf(metric)]) : null;
  return { value, previous, change: changeRatio(value, previous), share: null };
}

/** A pseudo widget result for the drill's queries, so the time series renderer can draw it. */
export function drillResult(base: WidgetResultDto, current: { columns: string[]; rows: unknown[][] },
  previous: { columns: string[]; rows: unknown[][] } | null): WidgetResultDto {
  const q = (d: { columns: string[]; rows: unknown[][] }) => ({
    status: 'ok' as const, query: {}, sql: null, columns: d.columns, rows: d.rows, truncated: false, ran_at: null, error: null,
  });
  return {
    ...base, status: 'ok', notes: [],
    queries: { current: q(current), ...(previous ? { current_previous: q(previous) } : {}) },
  };
}


