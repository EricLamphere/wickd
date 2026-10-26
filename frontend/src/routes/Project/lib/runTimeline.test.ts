import { describe, expect, it } from 'vitest';
import {
  MIN_BAR_PCT,
  buildTimeline,
  formatBytes,
  formatSeconds,
  gapSegments,
  parseUtc,
  tickStep,
  type TimelineNode,
} from './runTimeline';

const T0 = Date.parse('2026-10-22T10:00:00Z');

function node(uid: string, start: number | null, end: number | null, thread: string | null = 'Thread-1 (worker)'): TimelineNode {
  return {
    unique_id: uid,
    name: uid,
    kind: 'model',
    status: 'success',
    started_at: start === null ? null : new Date(T0 + start * 1000).toISOString(),
    completed_at: end === null ? null : new Date(T0 + end * 1000).toISOString(),
    thread_id: thread,
    rows_affected: null,
    bytes_processed: null,
  };
}

describe('parseUtc', () => {
  it('treats naive timestamps as UTC', () => {
    expect(parseUtc('2026-10-22T10:00:00')).toBe(T0);
    expect(parseUtc('2026-10-22T10:00:00+00:00')).toBe(T0);
    expect(parseUtc('2026-10-22T10:00:00Z')).toBe(T0);
  });
  it('returns null for missing or invalid values', () => {
    expect(parseUtc(null)).toBeNull();
    expect(parseUtc('nope')).toBeNull();
  });
});

describe('buildTimeline', () => {
  it('returns null when nothing has timing', () => {
    expect(buildTimeline([node('a', null, null)])).toBeNull();
  });

  it('positions bars as a share of wall time', () => {
    const layout = buildTimeline([node('a', 0, 10), node('b', 10, 40)])!;
    expect(layout.wallS).toBe(40);
    const [a, b] = layout.bars;
    expect(a).toMatchObject({ uniqueId: 'a', leftPct: 0, widthPct: 25, durationS: 10 });
    expect(b).toMatchObject({ uniqueId: 'b', leftPct: 25, widthPct: 75, startS: 10 });
  });

  it('gives each thread a lane, sorted numerically', () => {
    const layout = buildTimeline([
      node('a', 0, 5, 'Thread-10 (worker)'),
      node('b', 0, 5, 'Thread-2 (worker)'),
      node('c', 5, 9, 'Thread-2 (worker)'),
    ])!;
    expect(layout.lanes).toEqual(['Thread-2 (worker)', 'Thread-10 (worker)']);
    expect(layout.bars.map((b) => [b.uniqueId, b.lane])).toEqual([['b', 0], ['c', 0], ['a', 1]]);
  });

  it('packs nodes without a thread id into extra lanes', () => {
    const layout = buildTimeline([
      node('a', 0, 10, 'Thread-1'),
      node('x', 0, 5, null),
      node('y', 2, 6, null),
      node('z', 5, 8, null),
    ])!;
    expect(layout.lanes).toEqual(['Thread-1', 'Lane 1', 'Lane 2']);
    const laneOf = Object.fromEntries(layout.bars.map((b) => [b.uniqueId, b.lane]));
    expect(laneOf).toEqual({ a: 0, x: 1, y: 2, z: 1 });
  });

  it('widens very short bars and counts untimed nodes', () => {
    const layout = buildTimeline([node('slow', 0, 1000), node('fast', 500, 500.01), node('skipped', null, null)])!;
    const fast = layout.bars.find((b) => b.uniqueId === 'fast')!;
    expect(fast.widthPct).toBe(MIN_BAR_PCT);
    expect(layout.untimed).toBe(1);
  });

  it('keeps a widened bar at the very end inside the chart', () => {
    const layout = buildTimeline([node('slow', 0, 1000), node('last', 1000, 1000)])!;
    const last = layout.bars.find((b) => b.uniqueId === 'last')!;
    expect(last.leftPct + last.widthPct).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('handles a zero-length run', () => {
    const layout = buildTimeline([node('a', 0, 0)])!;
    expect(layout.wallS).toBe(0);
    expect(layout.bars[0].widthPct).toBeGreaterThan(0);
    expect(layout.ticks).toEqual([{ seconds: 0, pct: 0, label: '0s' }]);
  });

  it('adds nice ticks from 0 to the wall time', () => {
    const layout = buildTimeline([node('a', 0, 60)])!;
    expect(layout.ticks.map((t) => t.label)).toEqual(['0s', '10s', '20s', '30s', '40s', '50s', '1m']);
    expect(layout.ticks[6].pct).toBe(100);
  });
});

describe('tickStep', () => {
  it('picks the smallest nice step covering the target tick count', () => {
    expect(tickStep(3)).toBe(0.5);
    expect(tickStep(60)).toBe(10);
    expect(tickStep(600)).toBe(120);
  });
});

describe('gapSegments', () => {
  it('draws labelled waits ending at the node bar', () => {
    const layout = buildTimeline([node('a', 0, 10), node('other', 10, 40, 'Thread-2 (worker)'), node('b', 40, 50)])!;
    const segments = gapSegments(layout, [
      { unique_id: 'a', wait_before_s: 0, wait_kind: null },
      { unique_id: 'b', wait_before_s: 30, wait_kind: 'starvation' },
    ]);
    expect(segments).toEqual([{ lane: 0, leftPct: 20, widthPct: 60, kind: 'starvation', seconds: 30 }]);
  });
});

describe('formatting', () => {
  it('formats seconds', () => {
    expect(formatSeconds(0)).toBe('0s');
    expect(formatSeconds(2.34)).toBe('2.3s');
    expect(formatSeconds(90)).toBe('1m 30s');
    expect(formatSeconds(120)).toBe('2m');
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 ** 3)).toBe('50 GB');
  });
});
