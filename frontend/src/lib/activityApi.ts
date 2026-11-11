// GET /api/projects/{id}/activity — what a project is running now (plan 29), mirroring
// backend/app/api/activity.py.
import { get } from './api';

export interface RunActivityDto {
  command: string;
  label: string;
  select: string | null;
  started_at: string;
  /** the Runs page row, when recorded */
  invocation_id: number | null;
  /** the command as typed (`dbt build --select orders+`), for copying */
  command_line: string;
}

export interface InitActivityDto {
  steps: string[];
  current_step: string | null;
  /** steps reached so far, including the one running */
  started: number;
  started_at: string;
}

export interface SimpleActivityDto {
  /** null when the start time isn't tracked (docs) */
  started_at: string | null;
}

export interface ActivitySnapshotDto {
  run: RunActivityDto | null;
  init: InitActivityDto | null;
  compile: SimpleActivityDto | null;
  docs: SimpleActivityDto | null;
}

export const activityApi = {
  get: (projectId: number) => get<ActivitySnapshotDto>(`/projects/${projectId}/activity`),
};
