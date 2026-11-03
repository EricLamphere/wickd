// Typed helpers for contract checks (wickd Pro, plan 05): breaking changes in the Impact tab's
// Uncommitted / Branch modes. Both routes are Pro-gated (403 pro_feature_required →
// isProFeatureRequiredError(); 503 when this build lacks the Pro package).
import { get, post } from './api';

export type ContractScope = 'working' | 'branch';
export type ContractSeverity = 'none' | 'info' | 'warning' | 'error';

export interface NamedNode { unique_id: string; name: string }

export interface ContractConsumers {
  models: (NamedNode & { columns: string[] })[];
  /** models that filter, join or group on the column */
  row_uses: NamedNode[];
  /** children that couldn't be traced but mention the column */
  possibly: NamedNode[];
  tests: NamedNode[];
  exposures: NamedNode[];
  semantic_models: (NamedNode & { fields: { kind: 'entity' | 'dimension' | 'measure'; name: string; uncertain: boolean }[] })[];
  metrics: string[];
  saved_queries: string[];
  dashboards: { slug: string; title: string }[];
  monitors: { id: number; metric: string; grain?: string }[];
}

export interface BreakingChange {
  change: 'removed' | 'renamed' | 'retyped';
  column: string;
  to?: string;
  from_type?: string;
  to_type?: string;
  severity: ContractSeverity;
  consumers: ContractConsumers;
}

export interface ContractFinding {
  kind: 'missing' | 'extra' | 'type_mismatch' | 'unknown_columns';
  column?: string;
  declared_type?: string;
  actual_type?: string;
}

export interface ColumnDiff {
  removed: string[];
  added: string[];
  renamed: { from: string; to: string }[];
  retyped: { column: string; from: string; to: string }[];
}

export interface ContractResult {
  unique_id: string;
  name: string;
  contracted: boolean;
  versioned: boolean;
  access: string | null;
  new_model: boolean;
  columns_known: boolean;
  base_known: boolean;
  head_columns: string[];
  base_columns: string[];
  contract_findings: ContractFinding[];
  column_diff: ColumnDiff | null;
  breaking_changes: BreakingChange[];
  severity: ContractSeverity;
  suggestion: string | null;
  /** dbt's own state:modified.contract verdict; null until a state directory exists (plan 18) */
  dbt_state_contract: boolean | null;
}

export interface ContractCheckDto {
  id: number;
  project_id: number;
  scope: ContractScope;
  base: string | null;
  base_sha: string | null;
  types: boolean;
  status: 'running' | 'done' | 'error';
  /** while running: changes | compiling_head | compiling_base | types | checking */
  phase: string | null;
  target: string | null;
  started_at: string;
  finished_at: string | null;
  results: ContractResult[];
  notes: string[];
  lineage_used: boolean;
  error_message: string | null;
}

export const contractsApi = {
  start: (projectId: number, scope: ContractScope, base: string | null, types: boolean) =>
    post<ContractCheckDto>(`/projects/${projectId}/impact/contracts`, { scope, base, types }),
  latest: (projectId: number, scope: ContractScope) =>
    get<ContractCheckDto | null>(`/projects/${projectId}/impact/contracts?scope=${scope}`),
};
