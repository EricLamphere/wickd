// Typed helpers for scheduled runs (plan 27): a dbt command run every N hours or on a
// cron schedule while wickd is open. Validation errors are 400 {field, code, message}.
import { del, get, patch, post, put } from './api';

/** pending/running while a fire is in flight; missed / skipped_busy / invalid never became a run */
export type ScheduleOutcome =
  | 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'missed' | 'skipped_busy' | 'invalid';

export interface RunScheduleDto {
  id: number;
  name: string;
  command: string;
  interval_hours: number | null;
  cron: string | null;
  /** null = the active target when it fires */
  target: string | null;
  /** the command's own --target, which wins over `target` */
  command_target: string | null;
  has_command_target: boolean;
  catch_up: boolean;
  busy_wait_minutes: number;
  enabled: boolean;
  position: number;
  description: string;
  next_run_at: string | null;
  last_fired_at: string | null;
  last_status: ScheduleOutcome | null;
  last_invocation_id: number | null;
  last_event_id: number | null;
  pending: boolean;
  created_at: string | null;
}

export interface RunScheduleListDto {
  paused: boolean;
  items: RunScheduleDto[];
}

export interface RunScheduleBody {
  name: string;
  command: string;
  interval_hours: number | null;
  cron: string | null;
  target: string | null;
  catch_up: boolean;
  busy_wait_minutes: number;
  enabled?: boolean;
}

export interface ScheduleEventDto {
  id: number;
  at: string | null;
  trigger: 'schedule' | 'manual';
  outcome: ScheduleOutcome;
  invocation_id: number | null;
  message: string;
}

export interface SchedulePreviewDto {
  expr: string;
  next: string[];
}

const base = (projectId: number) => `/projects/${projectId}/run-schedules`;

export const schedulesApi = {
  list: (projectId: number) => get<RunScheduleListDto>(base(projectId)),
  create: (projectId: number, body: RunScheduleBody) => post<RunScheduleDto>(base(projectId), body),
  update: (projectId: number, id: number, body: Partial<RunScheduleBody>) =>
    patch<RunScheduleDto>(`${base(projectId)}/${id}`, body),
  remove: (projectId: number, id: number) => del<void>(`${base(projectId)}/${id}`),
  reorder: (projectId: number, ids: number[]) => put<void>(`${base(projectId)}/order`, { ids }),
  setPaused: (projectId: number, paused: boolean) => put<{ paused: boolean }>(`${base(projectId)}/paused`, { paused }),
  runNow: (projectId: number, id: number) => post<{ event_id: number }>(`${base(projectId)}/${id}/run`),
  history: (projectId: number, id: number) => get<{ items: ScheduleEventDto[] }>(`${base(projectId)}/${id}/history`),
  /** A cron expression checked as you type (not Pro-gated; shared with metric monitors). */
  preview: (expr: string) => get<SchedulePreviewDto>(`/schedule-preview?expr=${encodeURIComponent(expr)}`),
};
