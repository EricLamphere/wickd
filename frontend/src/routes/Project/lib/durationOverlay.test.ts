import { describe, expect, it } from 'vitest';
import { MIN_SLOW_S, bucketFor, buildDurationMap, durationTitle, rankingGroup } from './durationOverlay';

const dto = (median_s: number, runs = 3) => ({ median_s, last_s: median_s, runs });

describe('bucketFor', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100s

  it('buckets by percentile rank', () => {
    expect(bucketFor(10, sorted)).toBe('fast');
    expect(bucketFor(51, sorted)).toBe('medium');
    expect(bucketFor(81, sorted)).toBe('slow');
    expect(bucketFor(96, sorted)).toBe('slowest');
  });

  it('never calls sub-second nodes slow', () => {
    expect(bucketFor(MIN_SLOW_S / 2, [0.1, 0.2, MIN_SLOW_S / 2])).toBe('fast');
  });

  it('treats ties as the same rank', () => {
    expect(bucketFor(5, [5, 5, 5, 5])).toBe('fast');
  });
});

describe('rankingGroup', () => {
  it('is the unique_id prefix', () => {
    expect(rankingGroup('model.p.a')).toBe('model');
    expect(rankingGroup('test.p.not_null_x.abc')).toBe('test');
    expect(rankingGroup('nodots')).toBe('nodots');
  });
});

describe('buildDurationMap', () => {
  it('maps every node and keeps median + runs', () => {
    const map = buildDurationMap({ 'model.p.a': dto(2), 'model.p.b': dto(2), 'model.p.c': dto(60, 7) });
    expect(map.get('model.p.a')).toEqual({ medianS: 2, runs: 3, bucket: 'fast' });
    expect(map.get('model.p.c')).toEqual({ medianS: 60, runs: 7, bucket: 'medium' }); // 2 of 3 strictly faster → rank 0.67
  });

  it('ranks each resource type against its own kind', () => {
    const tests = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`test.p.t${i}`, dto(1 + i * 0.1)]));
    const map = buildDurationMap({
      ...tests,
      'test.p.slow_test': dto(30),
      'model.p.a': dto(2), 'model.p.b': dto(3), 'model.p.c': dto(4),
    });
    // Models aren't pushed to the top by the many fast tests…
    expect(map.get('model.p.a')?.bucket).toBe('fast');
    expect(map.get('model.p.c')?.bucket).toBe('medium');
    // …and a slow test stands out among tests
    expect(map.get('test.p.slow_test')?.bucket).toBe('slowest');
    expect(map.get('test.p.t0')?.bucket).toBe('fast');
  });

  it('keeps seeds and snapshots in their own pools', () => {
    const map = buildDurationMap({
      'seed.p.s1': dto(1.5), 'seed.p.s2': dto(20),
      'model.p.m1': dto(100), 'model.p.m2': dto(200),
    });
    expect(map.get('seed.p.s2')?.bucket).toBe('medium'); // slower of the two seeds
    expect(map.get('seed.p.s1')?.bucket).toBe('fast');
  });

  it('describes a node', () => {
    expect(durationTitle({ medianS: 90, runs: 1, bucket: 'slow' })).toBe('Median 1m 30s over 1 successful run');
  });
});
