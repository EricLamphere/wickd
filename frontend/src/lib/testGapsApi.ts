// Typed helpers for Test gaps (wickd Pro): the riskiest untested columns, from the
// column lineage scan's join keys and grain, and a batch "tests" proposal for them
// (a regular AI proposal, see aiApi.ts). 409 lineage_not_ready → lineageNotReadyReason().
import { get, post } from './api';
import type { AiProposalDto } from './aiApi';

export interface TestGapCandidateDto {
  test: 'not_null' | 'unique' | 'relationships' | 'unique_combination_of_columns';
  evidence: string;
  /** grain: the model's GROUP BY / DISTINCT / dedupe; join: other models join on it */
  source: 'grain' | 'join' | string;
  /** relationships target unique_id and column */
  to: string | null;
  field: string | null;
  combination: string[] | null;
  /** join candidates: the models that join on it */
  models: string[];
}

export interface TestGapDto {
  key: string;
  unique_id: string;
  name: string;
  /** null for a model-level test (see columns) */
  column: string | null;
  columns: string[] | null;
  score: number;
  /** downstream columns traced from it */
  reach: number;
  /** models that filter / join / group on it (or on columns derived from it) */
  row_uses: number;
  exposures: number;
  in_grain: boolean;
  existing: string[];
  candidates: TestGapCandidateDto[];
}

export interface TestGapsDto {
  snapshot_id: number;
  /** columns with a suggestion, not counting ignored ones (rows may be limited) */
  total: number;
  /** rows the user ignored */
  ignored: number;
  rows: TestGapDto[];
}

export interface IgnoredGapDto {
  key: string;
  unique_id: string;
  name: string;
  /** column, or "(a, b)" */
  label: string;
  ignored_at: string;
  /** still suggested by the current ranking; null when column lineage isn't ready to tell */
  still_a_gap: boolean | null;
  candidates: TestGapCandidateDto[];
}

export const testGapsApi = {
  list: (projectId: number, limit = 50) => get<TestGapsDto>(`/projects/${projectId}/test-gaps?limit=${limit}`),
  ignored: (projectId: number) =>
    get<{ rows: IgnoredGapDto[] }>(`/projects/${projectId}/test-gaps/ignored`),
  /** Hide rows (TestGapDto.key) until they're unignored. */
  ignore: (projectId: number, keys: string[]) =>
    post<{ changed: number }>(`/projects/${projectId}/test-gaps/ignore`, { keys }),
  unignore: (projectId: number, keys: string[]) =>
    post<{ changed: number }>(`/projects/${projectId}/test-gaps/unignore`, { keys }),
  /** One proposal with the suggested tests for these rows (TestGapDto.key). */
  generate: (projectId: number, keys: string[]) =>
    post<AiProposalDto>(`/projects/${projectId}/ai/tests/batch`, { keys }),
};
