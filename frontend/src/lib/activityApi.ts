// GET /api/projects/{id}/activity — what a project is running now (plan 29), mirroring
// backend/app/api/activity.py; also the last finished runs (`recent`).
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

/** A finished dbt run from the Runs page (newest first), so the bubble's history survives a reload. */
export interface RecentRunDto {
  invocation_id: number;
  command: string;
  /** the command and its subcommand words (`source freshness`) */
  label: string;
  select: string | null;
  command_line: string;
  /** a cancelled run reads as error */
  status: 'success' | 'warn' | 'error';
  started_at: string | null;
  finished_at: string | null;
  /** the log's last lines */
  log: string[];
}

export interface ActivitySnapshotDto {
  run: RunActivityDto | null;
  init: InitActivityDto | null;
  compile: SimpleActivityDto | null;
  docs: SimpleActivityDto | null;
  /** the most recent finished dbt runs, newest first */
  recent: RecentRunDto[];
}

export const activityApi = {
  get: (projectId: number) => get<ActivitySnapshotDto>(`/projects/${projectId}/activity`),
};
