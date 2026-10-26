/**
 * Pure layout for the run timeline (Gantt chart): one lane per dbt thread, a
 * bar per node from its execute start to end, positioned as % of the run's
 * wall time, plus "nice" tick marks. Rendering lives in
 * RunHistory/RunTimeline.tsx.
 */

export interface TimelineNode {
  unique_id: string;
  name: string;
  kind: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  thread_id: string | null;
  rows_affected: number | null;
  bytes_processed: number | null;
}

export interface TimelineBar {
  uniqueId: string;
  name: string;
  kind: string;
  status: string;
  lane: number;
  startS: number;
  endS: number;
  durationS: number;
  leftPct: number;
  widthPct: number;
  rowsAffected: number | null;
  bytesProcessed: number | null;
}

export interface TimelineTick {
  seconds: number;
  pct: number;
  label: string;
}

export interface TimelineLayout {
  lanes: string[];
  bars: TimelineBar[];
  wallS: number;
  ticks: TimelineTick[];
  /** Nodes in the run without timing (skipped, or dbt didn't record it). */
  untimed: number;
}

export interface GapSegment {
  lane: number;
  leftPct: number;
  widthPct: number;
  kind: 'starvation' | 'overhead';
  seconds: number;
}

/** Bars narrower than this are widened so very fast nodes stay visible and clickable. */
export const MIN_BAR_PCT = 0.4;

const TICK_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** Timestamps without an offset are UTC (SQLite returns naive datetimes). */
export function parseUtc(iso: string | null): number | null {
  if (!iso) return null;
  const normalized = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

export function tickStep(wallS: number, targetTicks = 6): number {
  const ideal = wallS / Math.max(1, targetTicks);
  return TICK_STEPS_S.find((s) => s >= ideal) ?? TICK_STEPS_S[TICK_STEPS_S.length - 1];
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    const rounded = Math.round(seconds * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

function buildTicks(wallS: number): TimelineTick[] {
  if (wallS <= 0) return [{ seconds: 0, pct: 0, label: '0s' }];
  const step = tickStep(wallS);
  const ticks: TimelineTick[] = [];
  for (let s = 0; s <= wallS + 1e-9; s = Math.round((s + step) * 1000) / 1000) {
    ticks.push({ seconds: s, pct: (s / wallS) * 100, label: formatSeconds(s) });
  }
  return ticks;
}

/** "Thread-2 (worker)" before "Thread-10 (worker)". */
function compareThreads(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

interface Timed {
  node: TimelineNode;
  start: number;
  end: number;
}

/** Nodes without a thread id are packed greedily into extra lanes after the real threads. */
function assignLanes(timed: Timed[]): { lanes: string[]; laneOf: Map<Timed, number> } {
  const threads = [...new Set(timed.map((t) => t.node.thread_id).filter((t): t is string => !!t))].sort(compareThreads);
  const lanes = [...threads];
  const laneOf = new Map<Timed, number>();
  for (const t of timed) {
    if (t.node.thread_id) laneOf.set(t, threads.indexOf(t.node.thread_id));
  }
  const freeAt: number[] = [];
  for (const t of [...timed].filter((x) => !x.node.thread_id).sort((a, b) => a.start - b.start)) {
    let idx = freeAt.findIndex((end) => end <= t.start);
    if (idx === -1) {
      idx = freeAt.length;
      freeAt.push(0);
      lanes.push(`Lane ${idx + 1}`);
    }
    freeAt[idx] = t.end;
    laneOf.set(t, threads.length + idx);
  }
  return { lanes, laneOf };
}

export function buildTimeline(nodes: TimelineNode[]): TimelineLayout | null {
  const timed: Timed[] = [];
  for (const node of nodes) {
    const start = parseUtc(node.started_at);
    const end = parseUtc(node.completed_at);
    if (start !== null && end !== null && end >= start) timed.push({ node, start, end });
  }
  if (timed.length === 0) return null;

  const runStart = Math.min(...timed.map((t) => t.start));
  const runEnd = Math.max(...timed.map((t) => t.end));
  const wallS = (runEnd - runStart) / 1000;
  const { lanes, laneOf } = assignLanes(timed);
  const pct = (ms: number) => (wallS > 0 ? ((ms - runStart) / 1000 / wallS) * 100 : 0);

  const bars = timed
    .map((t): TimelineBar => {
      const rawLeft = pct(t.start);
      const widthPct = Math.max(wallS > 0 ? pct(t.end) - rawLeft : 100, MIN_BAR_PCT);
      // A bar widened at the very end shifts left rather than overflowing the chart
      const leftPct = Math.max(0, Math.min(rawLeft, 100 - widthPct));
      return {
        uniqueId: t.node.unique_id,
        name: t.node.name,
        kind: t.node.kind,
        status: t.node.status,
        lane: laneOf.get(t) ?? 0,
        startS: (t.start - runStart) / 1000,
        endS: (t.end - runStart) / 1000,
        durationS: (t.end - t.start) / 1000,
        leftPct,
        widthPct,
        rowsAffected: t.node.rows_affected,
        bytesProcessed: t.node.bytes_processed,
      };
    })
    .sort((a, b) => a.lane - b.lane || a.startS - b.startS);

  return { lanes, bars, wallS, ticks: buildTicks(wallS), untimed: nodes.length - timed.length };
}

/** Waits before critical-path nodes, drawn as segments ending where each node's bar starts. */
export function gapSegments(
  layout: TimelineLayout,
  path: { unique_id: string; wait_before_s: number; wait_kind: 'starvation' | 'overhead' | null }[],
): GapSegment[] {
  if (layout.wallS <= 0) return [];
  const barById = new Map(layout.bars.map((b) => [b.uniqueId, b]));
  const segments: GapSegment[] = [];
  for (const step of path) {
    const bar = barById.get(step.unique_id);
    if (!bar || !step.wait_kind || step.wait_before_s <= 0) continue;
    const startS = Math.max(0, bar.startS - step.wait_before_s);
    segments.push({
      lane: bar.lane,
      leftPct: (startS / layout.wallS) * 100,
      widthPct: ((bar.startS - startS) / layout.wallS) * 100,
      kind: step.wait_kind,
      seconds: step.wait_before_s,
    });
  }
  return segments;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
