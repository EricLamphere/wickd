// Typed helpers for metric debugging (plan 15): the Debug tab under the metric explorer.
// Base: the plan (MetricFlow's steps and joins) and its warehouse checks, reconcile with SQL.
// Pro: "Why is this number this?" (403 pro_feature_required → isProFeatureRequiredError()).
import { post } from './api';
import type { MetricQueryBody } from './semanticApi';

export type PlanNodeKind =
  | 'read' | 'metric_time' | 'join' | 'filter' | 'constrain_time' | 'aggregate' | 'compute' | 'combine'
  | 'join_over_time' | 'join_time_spine' | 'join_conversion' | 'semi_additive' | 'order_limit' | 'min_max'
  | 'window' | 'custom_granularity' | 'other';

export interface JoinTargetDto {
  entity: string | null;
  join_type: string | null;
  semantic_models: string[];
}

export interface PlanNodeDto {
  id: string;
  kind: PlanNodeKind;
  node_type: string;
  label: string;
  inputs: string[];
  /** index into `steps` (the SQL MetricFlow wrote for this step), null when none names it */
  step: number | null;
  semantic_model?: string | null;
  agg_time_dimension?: string | null;
  left_models?: string[];
  targets?: JoinTargetDto[];
  filters?: string[];
  metrics?: string[];
  time_range?: { start: string | null; end: string | null } | null;
  window?: string | null;
  grain_to_date?: string | null;
  join_type?: string | null;
  limit?: number | null;
}

export interface SqlStepDto {
  index: number;
  labels: string[];
  sql: string;
}

export type FindingStatus = 'ok' | 'info' | 'warn' | 'fail' | 'error' | 'skipped' | 'not_run';
export type FindingKind = 'input' | 'join' | 'dimension' | 'variants';

export interface FindingDto {
  id: string;
  kind: FindingKind;
  check: string;
  node: string | null;
  status: FindingStatus;
  title: string;
  value: string;
  detail: string;
  sql: string | null;
  data: Record<string, unknown>;
}

export interface DebugInputDto {
  metric: string;
  via: string;
  semantic_model: string | null;
  expr: string;
  agg: string | null;
  agg_time_dimension: string | null;
  filters: string[];
  /** the filters as SQL on the input's own table; null when one needs a join */
  filter_sql?: string | null;
}

export interface MetricDefInputDto {
  role: 'numerator' | 'denominator' | 'input';
  name: string;
  alias: string | null;
  filters: string[];
  offset: boolean;
}

export interface MetricDefDto {
  type: string;
  expr: string | null;
  filters: string[];
  inputs: MetricDefInputDto[];
}

export interface DebugModelDto {
  relation: string | null;
  entities: { name: string; type: string; expr: string }[];
  dimensions: { name: string; type: string; expr: string }[];
}

export interface DebugGroupByDto {
  name: string;
  kind: 'dimension' | 'time_dimension' | 'entity' | 'metric_time';
  element: string;
  entity_links: string[];
  semantic_model?: string;
  expr?: string;
}

export interface DebugResultDto {
  sql: string;
  columns: string[];
  plan: PlanNodeDto[];
  plan_error: string | null;
  steps: SqlStepDto[];
  checks: FindingDto[];
  warnings: FindingDto[];
  notes: string[];
  /** check queries in total; `ran` of them hit the warehouse on this request */
  queries: number;
  ran: number;
  ran_at: string | null;
  inputs: DebugInputDto[];
  group_by: DebugGroupByDto[];
  models: Record<string, DebugModelDto>;
  metric_defs?: Record<string, MetricDefDto>;
}

export interface ReconcileResultDto {
  columns: string[];
  rows: unknown[][];
  summary: { keys: number; matching: number; different: number; only_metric: number; only_sql: number };
  compared: string[];
  truncated: boolean;
  sql_truncated: boolean;
}

export interface ExplanationDto {
  headline: string;
  points: { text: string; finding_ids: string[]; severity: 'info' | 'warn' | 'fail' }[];
  causes: { title: string; finding_ids: string[]; score: number }[];
}

export const metricDebugApi = {
  debug: (projectId: number, query: MetricQueryBody, opts: { run?: boolean; refresh?: boolean } = {}) =>
    post<DebugResultDto>(`/projects/${projectId}/semantic/debug`, { query, run: opts.run ?? true, refresh: opts.refresh ?? false }),
  cancel: (projectId: number) => post<{ cancelled: boolean }>(`/projects/${projectId}/semantic/debug/cancel`, {}),
  reconcile: (projectId: number, query: MetricQueryBody, sql: string) =>
    post<ReconcileResultDto>(`/projects/${projectId}/semantic/debug/reconcile`, { query, sql }),
  explain: (projectId: number, query: MetricQueryBody) =>
    post<ExplanationDto>(`/projects/${projectId}/semantic/debug/explain`, { query }),
};
