// Typed helpers for metric dashboards (Base; plan 11): YAML files under the project's
// DASHBOARDS_PATH (default wickd/dashboards), cached widget results and batch refresh (plan 12).
// Mirrors backend/app/api/dashboards.py and app/semantic/dashboards.py.
import { del, get, post, put } from './api';
import type { AiProposalDto } from './aiApi';
import type { MetricQueryBody } from './semanticApi';

export type WidgetType = 'summary' | 'timeseries' | 'bar' | 'table' | 'leaderboard' | 'text';
export type PeriodPreset =
  | 'last_7_days' | 'last_30_days' | 'last_90_days' | 'last_12_months' | 'month_to_date' | 'quarter_to_date'
  | 'year_to_date' | 'last_month' | 'last_quarter' | 'all_time';
export type ComparePreset = 'none' | 'previous_period' | 'previous_year';
export type Grain = 'auto' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface DateRange {
  start: string;
  end: string;
}

export type CurrentPeriod = PeriodPreset | DateRange;
export type ComparePeriod = ComparePreset | DateRange;

export interface DashboardPeriod {
  current: CurrentPeriod;
  compare: ComparePeriod;
}

export interface DashboardWidget {
  id: string;
  type: WidgetType;
  title?: string;
  /** percent of the canvas width (widgets flow left to right in list order) */
  width: number;
  /** px */
  height: number;
  /** empty = waiting for a metric (always empty for text) */
  metrics?: string[];
  /** ANDed with the dashboard's filters */
  filters?: string[];
  /** overrides the dashboard's period, per key */
  period?: { current?: CurrentPeriod; compare?: ComparePeriod };
  /** type-specific (backend dashboard_plan.py *Options) */
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The file's contents (unknown keys are kept: send back what you got). */
export interface DashboardDoc {
  version: 1;
  title: string;
  description?: string;
  period?: DashboardPeriod;
  grain?: Grain;
  /** fixed canvas width (px); widget widths are percentages of it (default 1200) */
  canvas_width?: number;
  filters?: string[];
  widgets: DashboardWidget[];
  exposure?: string;
  [key: string]: unknown;
}

export interface DashboardSummaryDto {
  slug: string;
  /** relative to the project root */
  path: string;
  title: string;
  widget_count: number;
  exposure: string | null;
  /** the linked exposure per dbt's manifest (null when not linked): out_of_date = its metrics differ from the dashboard's */
  exposure_status: 'found' | 'out_of_date' | 'missing' | 'unknown' | null;
  /** what Update exposure would change: dashboard metrics it lacks, metrics it lists that left the dashboard */
  exposure_drift: { add: string[]; remove: string[] } | null;
  exposure_path: string | null;
  exposure_unique_id: string | null;
  /** why the file couldn't be read (it's still listed) */
  error: string | null;
  modified_at: string | null;
}

export interface DashboardDetailDto extends DashboardSummaryDto {
  dashboard: DashboardDoc | null;
}

export interface DashboardListDto {
  folder: string;
  dashboards: DashboardSummaryDto[];
}

export type QueryStatus = 'ok' | 'not_run' | 'error';

/** One of a widget's queries: `current`, `current_previous`, `total`, `total_previous`, `trend`, `trend_previous`. */
export interface WidgetQueryDto {
  status: QueryStatus;
  query: MetricQueryBody;
  sql: string | null;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  ran_at: string | null;
  error: string | null;
}

export interface WidgetResultDto {
  widget_id: string;
  /** empty = no metric yet */
  status: QueryStatus | 'empty';
  error: string | null;
  /** e.g. a dashboard filter that doesn't apply to this widget's metrics */
  notes: string[];
  grain: string | null;
  current: DateRange | null;
  previous: DateRange | null;
  /** the oldest of its queries' runs */
  ran_at: string | null;
  queries: Record<string, WidgetQueryDto>;
}

export interface DashboardResultsDto {
  target: string | null;
  profile_name: string | null;
  widgets: WidgetResultDto[];
}

const base = (projectId: number) => `/projects/${projectId}/dashboards`;
const one = (projectId: number, slug: string) => `${base(projectId)}/${encodeURIComponent(slug)}`;

export const dashboardsApi = {
  list: (projectId: number) => get<DashboardListDto>(base(projectId)),
  create: (projectId: number, title: string, widgets: DashboardWidget[] = []) =>
    post<DashboardDetailDto>(base(projectId), { title, widgets }),
  get: (projectId: number, slug: string) => get<DashboardDetailDto>(one(projectId, slug)),
  save: (projectId: number, slug: string, dashboard: DashboardDoc, baseModifiedAt?: string | null) =>
    put<DashboardDetailDto>(one(projectId, slug), { dashboard, base_modified_at: baseModifiedAt ?? null }),
  remove: (projectId: number, slug: string) => del<void>(one(projectId, slug)),
  results: (projectId: number, slug: string) => get<DashboardResultsDto>(`${one(projectId, slug)}/results`),
  refresh: (projectId: number, slug: string, widgetIds?: string[]) =>
    post<DashboardResultsDto>(`${one(projectId, slug)}/refresh`, { widget_ids: widgetIds ?? null }),
  /** unsaved widgets (Drill into…) with the dashboard's period and filters; `run` runs those without stored results */
  preview: (projectId: number, slug: string, widgets: DashboardWidget[], run = true) =>
    post<DashboardResultsDto>(`${one(projectId, slug)}/preview`, { widgets, run }),
  /** a dimension's values, largest first (served from the stored result when there is one) */
  dimensionValues: (projectId: number, metric: string, dimension: string) =>
    post<{ values: unknown[]; ran_at: string; source: 'warehouse' | 'cache' }>(
      `/projects/${projectId}/semantic/dimension-values`, { metric, dimension }),
  /** the exposure + the dashboard's `exposure:` key as a proposal (kind `exposure`) to review; nothing is written yet */
  proposeExposure: (projectId: number, slug: string, owner: string) =>
    post<AiProposalDto>(`${one(projectId, slug)}/exposure/propose`, { owner }),
  /** the linked exposure's `depends_on` metrics set to the dashboard's, as a proposal to review */
  proposeExposureUpdate: (projectId: number, slug: string) => post<AiProposalDto>(`${one(projectId, slug)}/exposure/update`),
  /** unlink and delete: the exposure removed from its YAML (the file deleted if that empties it) + the dashboard unlinked, to review */
  proposeExposureDelete: (projectId: number, slug: string) => post<AiProposalDto>(`${one(projectId, slug)}/exposure/delete`),
};
