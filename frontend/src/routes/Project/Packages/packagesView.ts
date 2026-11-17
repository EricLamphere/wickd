// Pure helpers for the Packages tab (plan 23): lock file diffs, "Upgrade all compatible",
// compatibility labels. Unit-tested in packagesView.test.ts.
import type { LockEntryDto, PackageChange, PackageRowDto } from '../../../lib/packagesApi';

export interface LockChange {
  key: string;
  from: string | null;
  to: string | null;
}

export interface LockDiff {
  added: LockChange[];
  removed: LockChange[];
  changed: LockChange[];
}

export const EMPTY_DIFF: LockDiff = { added: [], removed: [], changed: [] };

/** What `dbt deps` changed in package-lock.yml (entries matched by key). */
export function lockDiff(before: readonly LockEntryDto[], after: readonly LockEntryDto[]): LockDiff {
  const old = new Map(before.map((e) => [e.key, e.version]));
  const now = new Map(after.map((e) => [e.key, e.version]));
  const added = after.filter((e) => !old.has(e.key)).map((e) => ({ key: e.key, from: null, to: e.version }));
  const removed = before.filter((e) => !now.has(e.key)).map((e) => ({ key: e.key, from: e.version, to: null }));
  const changed = after
    .filter((e) => old.has(e.key) && old.get(e.key) !== e.version)
    .map((e) => ({ key: e.key, from: old.get(e.key) ?? null, to: e.version }));
  return { added, removed, changed };
}

export function diffIsEmpty(diff: LockDiff): boolean {
  return diff.added.length + diff.removed.length + diff.changed.length === 0;
}

/** Packages with a newer release this dbt-core can run, as set_version changes. */
export function upgradeAllChanges(rows: readonly PackageRowDto[]): PackageChange[] {
  return rows
    .filter((r) => r.direct && r.editable && r.upgrade_to)
    .map((r) => ({ op: 'set_version' as const, key: r.key, version: r.upgrade_to }));
}

export type Tone = 'ok' | 'warn' | 'fail' | 'muted';

export interface CompatLabel {
  text: string;
  tone: Tone;
  title: string;
}

export function rangeText(clauses: readonly string[]): string {
  return clauses.length ? clauses.join(', ') : 'any';
}

/** The compatibility cell: does this package's require-dbt-version accept the installed dbt-core? */
export function compatLabel(row: PackageRowDto, dbtVersion: string | null): CompatLabel {
  const range = `require-dbt-version: ${rangeText(row.require_dbt_version)}`;
  if (row.compatible === true) return { text: 'Compatible', tone: 'ok', title: `${range} accepts dbt ${dbtVersion ?? ''}`.trim() };
  if (row.compatible === false) return { text: 'Incompatible', tone: 'fail', title: `${range} rejects dbt ${dbtVersion ?? ''}`.trim() };
  if (!row.installed) return { text: 'Not installed', tone: 'warn', title: 'Run dbt deps to install it' };
  return { text: 'Unknown', tone: 'muted', title: dbtVersion ? range : 'dbt-core isn\'t installed' };
}

/** The "Latest" cell's hint: what an upgrade would do, or why it can't. */
export function latestHint(row: PackageRowDto): string | null {
  if (row.upgrade_to) return `Upgrade to ${row.upgrade_to}`;
  if (row.latest_blocked) return `${row.latest} needs a newer dbt-core`;
  return null;
}

/** True for the run_finished event of a `dbt deps`. */
export function isDepsFinished(event: { type: string; data?: unknown }): boolean {
  return event.type === 'run_finished' && (event.data as { command?: string } | undefined)?.command === 'deps';
}
