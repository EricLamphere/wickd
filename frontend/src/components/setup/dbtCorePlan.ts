import type { RequirementsFileDto } from '../../lib/api';

export type DbtCorePlanKind = 'no-file' | 'new-file' | 'append' | 'from-file' | 'missing' | 'checking';

export interface DbtCorePlan {
  kind: DbtCorePlanKind;
  /** Whether the user should choose a dbt-core version (nothing else decides it). */
  showPicker: boolean;
  /** One line for the review step: what global setup will install. */
  installs: string;
}

interface PlanInput {
  path: string;
  createFile: boolean;
  /** The requirements file check; null while loading (or when there's no path). */
  file: RequirementsFileDto | null;
  /** '' = latest */
  version: string;
}

function versionLabel(version: string): string {
  return version ? `dbt-core ${version}` : 'latest dbt-core';
}

/**
 * Where the dbt-core version comes from for the wizard's requirements choice:
 * a file that already lists dbt-core decides it; otherwise the user picks one,
 * which goes into the new file, is appended to the existing one, or (no file)
 * becomes the version global setup installs.
 */
export function dbtCorePlan({ path, createFile, file, version }: PlanInput): DbtCorePlan {
  const trimmed = path.trim();
  if (!trimmed) {
    return { kind: 'no-file', showPicker: true, installs: version ? versionLabel(version) : 'Latest dbt-core' };
  }
  if (!file) return { kind: 'checking', showPicker: false, installs: trimmed };
  if (file.exists && file.dbt_core_line) {
    return { kind: 'from-file', showPicker: false, installs: `${trimmed} (${file.dbt_core_line})` };
  }
  if (file.exists) return { kind: 'append', showPicker: true, installs: `${trimmed} (+ ${versionLabel(version)})` };
  if (!createFile) return { kind: 'missing', showPicker: false, installs: trimmed };
  return { kind: 'new-file', showPicker: true, installs: `${trimmed} (${versionLabel(version)})` };
}
