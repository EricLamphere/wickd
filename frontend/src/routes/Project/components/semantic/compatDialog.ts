import type { PackageChange, SemanticStatusDto } from '../../../../lib/semanticApi';

export interface VersionOption {
  version: string;
  label: string;
  recommended: boolean;
}

function parts(v: string): number[] {
  return v.split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
}

export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const minorOf = (v: string) => parts(v).slice(0, 2).join('.');

/** "1.10.23 — closest, same minor", "1.12.6 — latest", "1.9.11 — older", "1.10.13 — installed". */
export function labelFor(version: string, current: string | null, candidates: string[], recommended: string | null): string {
  const tags: string[] = [];
  if (current && version === current) tags.push('installed');
  if (version === recommended) tags.push(current && minorOf(version) === minorOf(current) ? 'closest, same minor' : 'closest');
  const latest = [...candidates].sort(compareVersions).at(-1);
  if (version === latest) tags.push('latest');
  if (!tags.length && current && compareVersions(version, current) < 0) tags.push('older');
  return tags.length ? `${version} — ${tags.join(', ')}` : version;
}

/**
 * Radio options, newest first. When MetricFlow already works with the installed
 * dbt-core (e.g. adding the `mf` CLI), the installed version comes first and is
 * the recommendation: installing it again only adds dbt-metricflow.
 */
export function versionOptions(status: Pick<SemanticStatusDto, 'dbt_core' | 'compatible_dbt_versions' | 'recommended_version' | 'reason_code'>): VersionOption[] {
  const current = status.dbt_core;
  const keepCurrent = !status.reason_code && current;
  const versions = [...new Set([...(keepCurrent ? [current] : []), ...status.compatible_dbt_versions])];
  const recommended = keepCurrent ? current : status.recommended_version;
  return versions
    .sort((a, b) => compareVersions(b, a))
    .map((version) => ({
      version,
      label: labelFor(version, current, status.compatible_dbt_versions, recommended),
      recommended: version === recommended,
    }));
}

export function defaultChoice(options: VersionOption[]): string | null {
  return options.find((o) => o.recommended)?.version ?? options[0]?.version ?? null;
}

/** null when `input` is a dbt-core release from `known`, else why not. */
export function otherVersionError(input: string, known: string[] | undefined): string | null {
  const v = input.trim();
  if (!v) return 'Enter a dbt-core version, e.g. 1.10.23';
  if (!/^\d+\.\d+\.\d+$/.test(v)) return 'Use a full release number like 1.10.23';
  if (known && known.length && !known.includes(v)) return `dbt-core ${v} isn't a published release`;
  return null;
}

export interface GroupedChanges {
  upgrades: PackageChange[];
  downgrades: PackageChange[];
  installs: PackageChange[];
}

export function groupChanges(changes: PackageChange[]): GroupedChanges {
  return {
    upgrades: changes.filter((c) => c.change === 'upgrade'),
    downgrades: changes.filter((c) => c.change === 'downgrade'),
    installs: changes.filter((c) => c.change === 'install'),
  };
}

export function describeChange(c: PackageChange): string {
  return c.before ? `${c.name} ${c.before} → ${c.after}` : `${c.name} ${c.after} (new)`;
}

export function dialogTitle(status: Pick<SemanticStatusDto, 'dbt_core' | 'reason_code'>, wantCli: boolean): string {
  if (!status.reason_code && wantCli) return 'Install the mf CLI into your dbt environment';
  if (!status.dbt_core) return 'MetricFlow needs dbt-core';
  return `MetricFlow can't run with dbt-core ${status.dbt_core}`;
}
