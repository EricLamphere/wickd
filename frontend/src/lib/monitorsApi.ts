// Typed helpers for metric monitors (wickd Pro): metrics watched for anomalies, refreshed
// after builds that touch them, on Check now, or on an interval while wickd is open.
// Every route is Pro-gated (403 pro_feature_required → isProFeatureRequiredError()).
import { del, get, patch, post, put } from './api';

export type MonitorGrain = 'day' | 'week' | 'month';
export type MonitorSensitivity = 'low' | 'normal' | 'high';
/** error = the refresh failed for this monitor; not_enough_history = nothing scored yet */
export type MonitorStatus = 'ok' | 'warn' | 'anomaly' | 'error' | 'not_enough_history';
export type PointKind = 'none' | 'warn' | 'anomaly' | 'missing' | 'zero' | 'restated' | 'level_shift';

export interface MonitorPointDto {
  period: string;
  value: number | null;
  expected: number | null;
  low: number | null;
  high: number | null;
  kind: PointKind;
  /** the current, incomplete period: drawn, never scored */
  partial: boolean;
  score?: number | null;
  suppressed?: boolean;
  restated?: boolean;
  previous?: number | null;
  shift?: { direction: 'up' | 'down'; since: string };
}

export interface MonitorLatestPoint {
  period: string;
  value: number | null;
  expected: number | null;
}

export interface MonitorSliceResult {
  slice: string;
  status: MonitorStatus;
  headline: string;
  since: string | null;
  latest: MonitorLatestPoint | null;
  counts: Partial<Record<PointKind, number>>;
  restated: number;
  flagged: MonitorPointDto[];
}

/** One monitor's latest detection summary (also a run's per-monitor result, without `recent`). */
export interface MonitorResultDto {
  monitor_id: number;
  metric: string;
  grain: MonitorGrain;
  dimension: string | null;
  target: string;
  status: MonitorStatus;
  headline: string;
  since: string | null;
  latest: MonitorLatestPoint | null;
  worst_slice: string | null;
  slices: MonitorSliceResult[];
  /** the worst slice's last points, for the card's sparkline */
  recent?: MonitorPointDto[];
  truncated: boolean;
  error: string | null;
  checked_at: string;
}

export interface MonitorDto {
  id: number;
  metric: string;
  grain: MonitorGrain;
  dimension: string | null;
  sensitivity: MonitorSensitivity;
  lookback: number;
  enabled: boolean;
  /** pinned dbt target; null follows the active one */
  target: string | null;
  slices: (string | number)[];
  /** order on the Monitors tab (drag to reorder) */
  position: number;
  created_at: string | null;
  last_checked_at: string | null;
  latest: MonitorResultDto | null;
}

export interface MonitorRunDto {
  id: number;
  status: 'running' | 'done' | 'error';
  trigger: 'build' | 'manual' | 'interval';
  target: string | null;
  monitors: number[];
  results: MonitorResultDto[];
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface MonitorListDto {
  monitors: MonitorDto[];
  running: boolean;
  interval_hours: number | null;
  max_monitors: number;
  active_target: string | null;
  last_run: MonitorRunDto | null;
}

export interface MonitorSeriesDto {
  monitor: MonitorDto;
  slice: string;
  slices: string[];
  target: string | null;
  points: MonitorPointDto[];
  summary: {
    status: Exclude<MonitorStatus, 'error'>;
    headline: string;
    since: string | null;
    latest: MonitorLatestPoint | null;
    counts: Partial<Record<PointKind, number>>;
    restated: number;
  };
  restatements: { period: string; value: number | null; previous_value: number; observed_at: string }[];
}

export interface MonitorCreateBody {
  metric: string;
  grain: MonitorGrain;
  dimension?: string | null;
  sensitivity?: MonitorSensitivity;
  lookback?: number;
  target?: string | null;
}

export interface MonitorPatchBody {
  sensitivity?: MonitorSensitivity;
  lookback?: number;
  enabled?: boolean;
  target?: string | null;
}

const base = (projectId: number) => `/projects/${projectId}/metric-monitors`;

export const monitorsApi = {
  list: (projectId: number) => get<MonitorListDto>(base(projectId)),
  create: (projectId: number, body: MonitorCreateBody) => post<MonitorDto>(base(projectId), body),
  update: (projectId: number, id: number, body: MonitorPatchBody) => patch<MonitorDto>(`${base(projectId)}/${id}`, body),
  remove: (projectId: number, id: number) => del<void>(`${base(projectId)}/${id}`),
  refresh: (projectId: number, ids?: number[]) =>
    post<{ run_id: number | null; queued: boolean }>(`${base(projectId)}/refresh`, { ids: ids ?? null }),
  latest: (projectId: number) => get<MonitorRunDto | null>(`${base(projectId)}/latest`),
  reorder: (projectId: number, ids: number[]) => put<void>(`${base(projectId)}/order`, { ids }),
  setInterval: (projectId: number, hours: number | null) =>
    put<{ interval_hours: number | null }>(`${base(projectId)}/settings`, { interval_hours: hours }),
  series: (projectId: number, id: number, slice: string) =>
    get<MonitorSeriesDto>(`${base(projectId)}/${id}/series?slice=${encodeURIComponent(slice)}`),
  suppress: (projectId: number, id: number, body: { slice: string; period: string; suppressed: boolean }) =>
    post<{ ok: boolean }>(`${base(projectId)}/${id}/points/suppress`, body),
};
