// Typed helpers for the semantic layer (MetricFlow) routes. Kept out of api.ts,
// which is already past the file-size limit; same request helpers and error type.
import { ApiError, get, post } from './api';

export type MetricflowMode = 'auto' | 'off';
export type SemanticSpec = 'legacy' | 'latest' | 'mixed' | 'none';

export interface SemanticStatusDto {
  available: boolean;
  can_query: boolean;
  mode: MetricflowMode;
  mode_source: 'project' | 'global';
  /** off | no_semantic_nodes | too_old | latest_spec_needs_1_12 | no_cli_release | unknown_version | unsupported_adapter */
  reason_code: string | null;
  reason: string | null;
  warning: string | null;
  dbt_core: string | null;
  python: string | null;
  engine_version: string;
  sidecar: 'missing' | 'stale' | 'ready';
  spec: SemanticSpec;
  adapter_type: string | null;
  counts: { semantic_models: number; metrics: number; saved_queries: number };
  compatible_dbt_versions: string[];
  recommended_version: string | null;
  cli_release: string | null;
}

export interface SemanticIssue {
  level: string;
  message: string;
  object_type: 'semantic_model' | 'metric' | 'saved_query' | null;
  object_name: string | null;
  element_type: string | null;
  element_name: string | null;
}

export interface WarehouseCheck {
  metric: string;
  ok: boolean;
  error: string | null;
}

export interface SemanticCheckDto {
  id: number;
  status: 'running' | 'done' | 'error';
  started_at: string | null;
  finished_at: string | null;
  results: {
    errors?: SemanticIssue[];
    warnings?: SemanticIssue[];
    future_errors?: SemanticIssue[];
    warehouse?: WarehouseCheck[] | null;
  };
  error_message: string | null;
  manifest_hash: string | null;
}

export interface PackageChange {
  name: string;
  before: string | null;
  after: string;
  change: 'upgrade' | 'downgrade' | 'install';
}

export interface RequirementPin {
  source: 'global' | 'project';
  path: string;
  line: number;
  text: string;
  spec: string;
  exact: boolean;
}

export interface DbtChangePlan {
  ok: boolean;
  version: string;
  previous_version: string | null;
  install: string[];
  changes: PackageChange[];
  pins: RequirementPin[];
  error: string | null;
}

export interface DbtChangeApplied {
  ok: boolean;
  previous_version: string | null;
  install: string[];
  pins_updated: { source: string; path: string; lines: number[] }[];
}

export interface DbtChangeVerified {
  dbt_core: string | null;
  parse_ok: boolean;
  parse_output: string;
  latest_spec_parse_error: boolean;
  status: SemanticStatusDto;
  finished_at: string;
}

export interface MetricflowEnvEvent {
  state: 'installing' | 'ready' | 'error';
  phase: string;
  message: string;
}

export interface SemanticErrorBody {
  error: string;
  message: string;
  status?: SemanticStatusDto;
}

/** The `{error, message}` body of a semantic route's error, if that's what `err` is. */
export function semanticErrorBody(err: unknown): SemanticErrorBody | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body as Partial<SemanticErrorBody> | null;
  return body && typeof body.error === 'string' ? { error: body.error, message: body.message ?? '', status: body.status } : null;
}

export const semanticApi = {
  status: (projectId: number, wantCli = false) =>
    get<SemanticStatusDto>(`/projects/${projectId}/semantic/status${wantCli ? '?want_cli=true' : ''}`),
  latestCheck: (projectId: number) => get<SemanticCheckDto | null>(`/projects/${projectId}/semantic/check/latest`),
  startCheck: (projectId: number, warehouse: boolean) =>
    post<SemanticCheckDto>(`/projects/${projectId}/semantic/check`, { warehouse }),
  planDbtChange: (projectId: number, version: string, wantCli: boolean) =>
    post<DbtChangePlan>(`/projects/${projectId}/metricflow/plan-dbt-change`, { version, want_cli: wantCli }),
  applyDbtChange: (projectId: number, body: { version: string; want_cli: boolean; update_pins: boolean; replace_ranges: boolean }) =>
    post<DbtChangeApplied>(`/projects/${projectId}/metricflow/apply-dbt-change`, body),
  verifyDbtChange: (projectId: number) => post<DbtChangeVerified>(`/projects/${projectId}/metricflow/verify-dbt-change`),
};
