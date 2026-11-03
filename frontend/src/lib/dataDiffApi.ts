// Typed helpers for data diff (wickd Pro, plan 06): changed models built in dev compared with
// their prod relations (DIFF_BASE_TARGET). All routes are Pro-gated (403 pro_feature_required →
// isProFeatureRequiredError(); 503 when this build lacks the Pro package).
import { get, post } from './api';

export type DataDiffMode = 'joined' | 'separate';
export type DataDiffStatus = 'added' | 'removed' | 'changed';

export interface DataDiffCounts {
  dev_rows?: number;
  prod_rows?: number;
  /** null without a key (counts and schema only) or when nothing could be fetched */
  added?: number | null;
  removed?: number | null;
  changed?: number | null;
  unchanged?: number | null;
}

export interface DataDiffColumn {
  name: string;
  numeric: boolean;
  changed: number;
  /** share of matched rows */
  pct: number | null;
  /** sum of dev − prod over changed rows (numeric columns) */
  delta_sum: number | null;
}

export interface DataDiffSample {
  key: unknown[];
  dev: unknown[] | null;
  prod: unknown[] | null;
  /** the compared columns that differ (changed rows) */
  changed: string[];
}

export interface DataDiffSchema {
  added: { name: string; type: string }[];
  removed: { name: string; type: string }[];
  retyped: { name: string; dev_type: string; prod_type: string }[];
}

export interface DataDiffResult {
  mode?: DataDiffMode | null;
  key?: string[] | null;
  counts?: DataDiffCounts;
  estimated?: boolean;
  columns?: DataDiffColumn[];
  schema?: DataDiffSchema;
  samples?: Record<DataDiffStatus, DataDiffSample[]>;
  sample_columns?: { key: string[]; columns: string[] };
  scanned?: { dev_rows?: number; prod_rows?: number; fetched_rows?: number };
  headline?: string;
  findings?: string[];
  notes?: string[];
  error?: { code: string; message: string; examples?: { side: string; key: unknown[]; count: number }[] } | null;
}

export interface DataDiffDto {
  id: number;
  unique_id: string;
  name: string;
  scope: string;
  base_ref: string | null;
  dev_target: string | null;
  prod_target: string | null;
  dev_relation: string | null;
  prod_relation: string | null;
  mode: DataDiffMode | null;
  key: string[];
  /** user | contract | unique_test | unique_combination | detected */
  key_source: string | null;
  columns: string[] | null;
  where: string | null;
  built: boolean;
  status: 'running' | 'done' | 'error';
  /** while running: queued | building | resolving | probing | comparing */
  phase: string | null;
  result: DataDiffResult | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface StartDataDiff {
  unique_ids: string[];
  scope: 'working' | 'branch';
  base?: string | null;
  keys?: Record<string, string[]>;
  columns?: Record<string, string[]>;
  where?: Record<string, string>;
  build?: boolean;
  mode?: 'auto' | 'separate';
  tolerance?: number;
}

export const dataDiffApi = {
  start: (projectId: number, body: StartDataDiff) => post<DataDiffDto[]>(`/projects/${projectId}/data-diff`, body),
  latest: (projectId: number) => get<DataDiffDto[]>(`/projects/${projectId}/data-diff/latest`),
  cancel: (projectId: number) => post<{ cancelled: boolean }>(`/projects/${projectId}/data-diff/cancel`, {}),
};
