/**
 * DAG "Durations" overlay: heat each node by its median successful run time,
 * relative to the rest of the project (so a project of 2s models still shows
 * which ones are slow). Data from GET /node-durations.
 */
import type { NodeDurationDto } from '../../../lib/api';
import { formatSeconds } from './runTimeline';

export type DurationBucket = 'fast' | 'medium' | 'slow' | 'slowest';

export interface NodeDurationData {
  medianS: number;
  runs: number;
  bucket: DurationBucket;
}

/** By percentile rank (share of nodes strictly faster): ≥0.95 slowest, ≥0.8 slow, ≥0.5 medium.
 *  Ties share a rank, so a project where everything takes the same time is all "fast". */
const RANK_CUTOFFS: Array<[number, DurationBucket]> = [[0.95, 'slowest'], [0.8, 'slow'], [0.5, 'medium']];
/** Below this nothing is "slow", however it ranks. */
export const MIN_SLOW_S = 1;

export const DURATION_CLASS: Record<DurationBucket, { badge: string; dot: string; ring: string }> = {
  fast: { badge: 'bg-emerald-950/40 text-emerald-300', dot: 'bg-emerald-500', ring: 'ring-emerald-700/70' },
  medium: { badge: 'bg-yellow-950/40 text-yellow-300', dot: 'bg-yellow-500', ring: 'ring-yellow-600/70' },
  slow: { badge: 'bg-orange-950/40 text-orange-300', dot: 'bg-orange-500', ring: 'ring-orange-500' },
  slowest: { badge: 'bg-red-950/50 text-red-300', dot: 'bg-red-500', ring: 'ring-red-500' },
};

export const DURATION_LEGEND: Array<{ bucket: DurationBucket; label: string }> = [
  { bucket: 'fast', label: 'fastest half' },
  { bucket: 'medium', label: 'top 50%' },
  { bucket: 'slow', label: 'top 20%' },
  { bucket: 'slowest', label: 'top 5%' },
];

/** Number of values in `sorted` strictly less than `value`. */
function countBelow(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function bucketFor(medianS: number, sortedMedians: number[]): DurationBucket {
  if (medianS < MIN_SLOW_S || sortedMedians.length === 0) return 'fast';
  const rank = countBelow(sortedMedians, medianS) / sortedMedians.length;
  return RANK_CUTOFFS.find(([cut]) => rank >= cut)?.[1] ?? 'fast';
}

/** Resource type from the unique_id prefix (`model.`, `test.`, `seed.`, `snapshot.`, …). */
export function rankingGroup(uid: string): string {
  const dot = uid.indexOf('.');
  return dot === -1 ? uid : uid.slice(0, dot);
}

/** Each node is ranked against nodes of its own type: models vs models, tests vs tests, etc.
 *  A mixed pool would put every model in the top 5% (tests are many and fast) and every test
 *  in the fastest half. */
export function buildDurationMap(nodes: Record<string, NodeDurationDto>): Map<string, NodeDurationData> {
  // Local accumulator (projects can have thousands of tests, so no copy-per-node)
  const pools = new Map<string, number[]>();
  for (const [uid, n] of Object.entries(nodes)) {
    const group = rankingGroup(uid);
    const pool = pools.get(group);
    if (pool) pool.push(n.median_s);
    else pools.set(group, [n.median_s]);
  }
  for (const medians of pools.values()) medians.sort((a, b) => a - b);
  return new Map(
    Object.entries(nodes).map(([uid, n]) => [
      uid,
      { medianS: n.median_s, runs: n.runs, bucket: bucketFor(n.median_s, pools.get(rankingGroup(uid)) ?? []) },
    ]),
  );
}

export function durationLabel(d: NodeDurationData): string {
  return formatSeconds(d.medianS);
}

export function durationTitle(d: NodeDurationData): string {
  return `Median ${formatSeconds(d.medianS)} over ${d.runs} successful run${d.runs === 1 ? '' : 's'}`;
}
