/**
 * When the desktop app offers an update (plan 32). Pure, unit-tested in updatePolicy.test.ts.
 */

/** Checked on launch, then this often while the app stays open. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface ParsedVersion {
  parts: number[];
  pre: string | null;
}

function parse(version: string): ParsedVersion {
  const [core, pre] = version.trim().replace(/^v/, '').split('-', 2);
  return { parts: core.split('.').map((p) => Number.parseInt(p, 10) || 0), pre: pre ?? null };
}

/** Semver order: negative when a < b, 0 when equal, positive when a > b. A pre-release
 * (1.4.0-beta.1) sorts below its release (1.4.0). */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  const length = Math.max(pa.parts.length, pb.parts.length, 3);
  for (let i = 0; i < length; i++) {
    const diff = (pa.parts[i] ?? 0) - (pb.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export interface NotifyInput {
  /** The version the update server offers, or null when there's none. */
  available: string | null;
  current: string;
  /** Global Settings' update_skipped_version. */
  skipped: string | null;
  /** The version "Later" hid for this launch. */
  laterVersion: string | null;
  /** Global Settings' update_check_enabled. */
  enabled: boolean;
}

/** Show the update bar? Only for a strictly newer version the user hasn't skipped or put off. */
export function shouldNotify({ available, current, skipped, laterVersion, enabled }: NotifyInput): boolean {
  if (!enabled || !available) return false;
  if (compareVersions(available, current) <= 0) return false;
  if (skipped && compareVersions(available, skipped) === 0) return false;
  if (laterVersion && compareVersions(available, laterVersion) === 0) return false;
  return true;
}

/** Whole-number download progress, or null when the server didn't send a size. */
export function downloadPercent(downloaded: number, total: number | undefined): number | null {
  if (!total) return null;
  return Math.min(100, Math.floor((downloaded / total) * 100));
}

export interface BusyActivity {
  project: string | null;
  label: string;
}

function describeActivity({ project, label }: BusyActivity): string {
  return project ? `${label} in ${project}` : label;
}

/** The warning shown before an update would stop running work. */
export function busyMessage(activities: BusyActivity[]): string {
  const items = activities.map(describeActivity);
  return items.length === 1
    ? `Updating restarts wickd and will stop ${items[0]}.`
    : `Updating restarts wickd and will stop: ${items.join('; ')}.`;
}
