// Typed helpers for dbt Charts (Base; plan 17): boards under the project's charts/ folder,
// static builds (`dct render --format html`), `dct validate`, live boards (`dct serve`) and
// exporting a wickd dashboard as board YAML. Mirrors backend/app/api/charts.py.
import { ApiError, del, get, post } from './api';
import type { AiProposalDto } from './aiApi';

export type SidecarState = 'missing' | 'stale' | 'needs_extra' | 'ready';

export interface ChartsDiagnostic {
  code: string;
  level: 'error' | 'warning' | string;
  message: string;
  hint: string | null;
  chart: string | null;
  query: string | null;
  line: number | null;
}

export interface BoardBuild {
  ok: boolean;
  built_at: string;
  target: string | null;
  elapsed_ms: number;
  diagnostics: ChartsDiagnostic[];
  error: string | null;
  has_output: boolean;
}

export interface ChartBoard {
  /** path under charts/ without the suffix ("team/ops") */
  id: string;
  /** relative to the project root ("charts/team/ops.yml") */
  path: string;
  /** where `dct serve` serves it ("team/ops"; "team" for team/index.yml) */
  url_path: string;
  title: string;
  chart_count: number;
  /** the file doesn't parse (it's still listed) */
  error: string | null;
  build: BoardBuild | null;
  building: boolean;
}

export interface ChartsListDto {
  has_charts_dir: boolean;
  boards: ChartBoard[];
  version: string;
  sidecar: SidecarState;
  live: { running: boolean; port: number | null };
}

export interface BoardValidation {
  ok: boolean;
  errors: ChartsDiagnostic[];
  warnings: ChartsDiagnostic[];
}

export interface LiveServerDto {
  running: boolean;
  port: number;
  base_url: string;
}

/** `charts_env` on the global stream while the sidecar is installed. */
export interface ChartsEnvEvent {
  state: 'installing' | 'ready' | 'error';
  phase: string;
  message: string;
}

const base = (projectId: number) => `/projects/${projectId}/charts`;
const board = (id: string) => `board=${encodeURIComponent(id)}`;

export const chartsApi = {
  list: (projectId: number) => get<ChartsListDto>(base(projectId)),
  /** starts a static build in the background; `charts_build_finished` when done */
  build: (projectId: number, boardId: string) => post<{ board: string; building: boolean }>(`${base(projectId)}/build?${board(boardId)}`),
  validate: (projectId: number) => post<{ boards: Record<string, BoardValidation> }>(`${base(projectId)}/validate`),
  /** start (or reuse) the project's `dct serve` */
  startLive: (projectId: number) => post<LiveServerDto>(`${base(projectId)}/live`),
  touchLive: (projectId: number) => post<{ running: boolean }>(`${base(projectId)}/live/touch`),
  stopLive: (projectId: number) => del<void>(`${base(projectId)}/live`),
  /** the dashboard as charts/<slug>.yml, as a proposal to review */
  proposeExport: (projectId: number, slug: string) =>
    post<AiProposalDto>(`/projects/${projectId}/dashboards/${encodeURIComponent(slug)}/export/dct`),
};

/** The URL of a board's last static build (cache-busted by the build time). */
export function staticBoardUrl(projectId: number, b: ChartBoard): string {
  return `/api${base(projectId)}/static?${board(b.id)}&v=${encodeURIComponent(b.build?.built_at ?? '')}`;
}

export function chartsErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message);
    if (typeof detail === 'string') return detail;
  }
  return err instanceof Error ? err.message : String(err);
}
