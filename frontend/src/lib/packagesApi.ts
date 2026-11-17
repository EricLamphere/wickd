// Typed helpers for the package manager (Base; plan 23): a project's dbt packages with
// versions and dbt-core compatibility, dbt Hub search, packages.yml edits as proposals
// (kind `packages`), and dbt deps. Mirrors backend/app/api/packages.py.
import { ApiError, get, post } from './api';
import type { AiProposalDto } from './aiApi';

export type PackageSource = 'hub' | 'git' | 'local' | 'tarball' | 'private' | 'unknown' | 'dependency';

export interface PackageRowDto {
  key: string;
  name: string;
  source: PackageSource;
  direct: boolean;
  requested: string | null;
  locked: string | null;
  installed: string | null;
  project_name: string | null;
  require_dbt_version: string[];
  compatible: boolean | null;
  hub_name: string | null;
  latest: string | null;
  latest_compatible: string | null;
  upgrade_to: string | null;
  latest_blocked: boolean;
  editable: boolean;
  notes: string[];
}

export interface LockEntryDto {
  key: string;
  source: string;
  version: string | null;
}

export interface ProjectPackagesDto {
  file: string | null;
  lock_present: boolean;
  install_path: string;
  dbt_version: string | null;
  hub_unreachable: boolean;
  rows: PackageRowDto[];
  lock: LockEntryDto[];
  errors: string[];
}

export type PackageChangeOp = 'add' | 'set_version' | 'remove';

export interface PackageChange {
  op: PackageChangeOp;
  key: string;
  version?: string | null;
}

export interface HubSearchDto {
  reachable: boolean;
  results: string[];
}

export interface HubVersionDto {
  version: string;
  require_dbt_version: string[];
  compatible: boolean | null;
  published_at: string | null;
}

export interface HubPackageDto {
  namespace: string;
  name: string;
  full_name: string;
  description: string;
  latest: string | null;
  latest_compatible: string | null;
  dbt_version: string | null;
  repo_url: string | null;
  versions: HubVersionDto[];
}

export interface CompatPackageDto {
  name: string;
  installed: string | null;
  require_dbt_version: string[];
}

export interface ProjectCompatDto {
  project_id: number;
  name: string;
  incompatible: CompatPackageDto[];
}

export interface CompatDto {
  dbt_version: string | null;
  projects: ProjectCompatDto[];
}

const hubPath = (fullName: string) => fullName.split('/').map(encodeURIComponent).join('/');

export const packagesApi = {
  list: (projectId: number) => get<ProjectPackagesDto>(`/projects/${projectId}/packages`),
  propose: (projectId: number, changes: PackageChange[]) =>
    post<AiProposalDto>(`/projects/${projectId}/packages/propose`, { changes }),
  deps: (projectId: number, upgrade: boolean) =>
    post<{ accepted: boolean; command: string }>(`/projects/${projectId}/packages/deps`, { upgrade }),
  hubSearch: (q: string) => get<HubSearchDto>(`/packages/hub/search?q=${encodeURIComponent(q)}`),
  hubPackage: (fullName: string) => get<HubPackageDto>(`/packages/hub/${hubPath(fullName)}`),
  hubReadme: (fullName: string, version: string) =>
    get<{ text: string | null }>(`/packages/hub/${hubPath(fullName)}/readme?version=${encodeURIComponent(version)}`),
  compat: (dbtVersion?: string) =>
    get<CompatDto>(`/packages/compat${dbtVersion ? `?dbt_version=${encodeURIComponent(dbtVersion)}` : ''}`),
};

export function packagesErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) {
    const body = err.body; // already the response's `detail`
    if (typeof body === 'string') return body;
    if (body && typeof body === 'object' && 'message' in body) return String((body as { message: unknown }).message);
  }
  return err instanceof Error ? err.message : fallback;
}
