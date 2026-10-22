import type { SourceFreshnessResult } from '../../../lib/api';

const PERIOD_SECONDS: Record<string, number> = { minute: 60, hour: 3600, day: 86_400 };

/** Share of the warn threshold at which a passing source is flagged as approaching it. */
export const APPROACHING_WARN_RATIO = 0.75;

const STATUS_RANK: Record<string, number> = { 'runtime error': 3, error: 3, warn: 2, pass: 1 };

export function periodSeconds(count: number | null, period: string | null): number | null {
  if (count == null || !period || !(period in PERIOD_SECONDS)) return null;
  return count * PERIOD_SECONDS[period];
}

/** Age as a fraction of the error threshold (the warn threshold when there's no error one). */
export function errorThresholdRatio(r: SourceFreshnessResult): number | null {
  const limit = periodSeconds(r.error_after_count, r.error_after_period)
    ?? periodSeconds(r.warn_after_count, r.warn_after_period);
  if (r.age_seconds == null || !limit) return null;
  return r.age_seconds / limit;
}

/** A passing source that's most of the way to its warn threshold. */
export function isApproachingWarn(r: SourceFreshnessResult): boolean {
  const warn = periodSeconds(r.warn_after_count, r.warn_after_period);
  return r.status === 'pass' && r.age_seconds != null && !!warn
    && r.age_seconds / warn >= APPROACHING_WARN_RATIO;
}

/** Worst status first, then closest to its error threshold; unknown ages last. */
export function sortByUrgency(results: readonly SourceFreshnessResult[]): SourceFreshnessResult[] {
  return [...results].sort((a, b) => {
    const byStatus = (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0);
    if (byStatus !== 0) return byStatus;
    return (errorThresholdRatio(b) ?? -1) - (errorThresholdRatio(a) ?? -1);
  });
}
