// Typed helpers for slim builds (plan 18): the state source, a preview of a state: selection,
// dbt clone and dbt retry. The prune option of the preview is Pro (403 pro_feature_required →
// isProFeatureRequiredError(); 503 when this build lacks the Pro package).
import { get, post, type RunResponseDto } from './api';

export const STATE_METHODS = [
  'state:modified',
  'state:new',
  'state:modified.body',
  'state:modified.configs',
  'state:modified.contract',
] as const;
export type StateMethod = (typeof STATE_METHODS)[number];

export interface StateDto {
  kind: 'git' | 'path';
  ref: string | null;
  folder: string | null;
  sha: string | null;
  /** the target the manifest's relations belong to (null: the active one / unknown) */
  target: string | null;
  generated_at: string | null;
  dbt_version: string | null;
  notes: string[];
  /** --state folder (what changed) */
  state_path: string;
  /** --defer-state / clone folder (prod's relations) */
  defer_path: string;
}

export interface StatePreviewRequest {
  method: StateMethod;
  downstream: boolean;
  scope: 'working' | 'branch';
  base: string | null;
  prune: boolean;
}

export interface StatePreviewNode {
  unique_id: string;
  name: string;
  resource_type: string;
  changed: boolean;
  selected: boolean;
  /** dbt build does something for it (false for sources, exposures, metrics, semantic models, saved queries) */
  buildable: boolean;
  reason: string | null;
  /** affected columns (Pro pruning); null = every column */
  columns: string[] | null;
}

export interface StatePreviewDto {
  state: StateDto;
  /** the state selector dbt was asked for, e.g. state:modified+ */
  selector: string;
  /** what Build passes to --select (the selector, or the pruned node list) */
  select: string;
  /** select uses state: methods, so --state must be passed */
  needs_state: boolean;
  nodes: StatePreviewNode[];
  /** tests that ride along with the selected nodes */
  tests: number;
  pruned: boolean;
  /** dbt sees these as changed, git doesn't */
  dbt_only: string[];
  /** git changed these files, dbt doesn't see a change */
  git_only: string[];
  notes: string[];
  /** prune was asked for but column lineage is missing or stale: load it, then preview again */
  lineage_needed: boolean;
}

export const slimApi = {
  state: (projectId: number) => get<StateDto>(`/projects/${projectId}/state`),
  preview: (projectId: number, body: StatePreviewRequest) =>
    post<StatePreviewDto>(`/projects/${projectId}/state/preview`, body),
  clone: (projectId: number, select: string, fullRefresh = false) =>
    post<RunResponseDto>(`/projects/${projectId}/clone`, { select, full_refresh: fullRefresh }),
  /** `dbt retry` of the project's last run; 409 with the reason when it can't */
  retry: (projectId: number, invocationId?: number) =>
    post<RunResponseDto>(`/projects/${projectId}/runs/retry`, { invocation_id: invocationId ?? null }),
};
