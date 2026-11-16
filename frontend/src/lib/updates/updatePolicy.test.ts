import { describe, expect, it } from 'vitest';
import { busyMessage, compareVersions, downloadPercent, shouldNotify } from './updatePolicy';

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.9.9', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('treats equal versions (with or without a v) as equal', () => {
    expect(compareVersions('1.4.0', 'v1.4.0')).toBe(0);
  });

  it('ranks a pre-release below its release', () => {
    expect(compareVersions('1.4.0-beta.1', '1.4.0')).toBeLessThan(0);
    expect(compareVersions('1.4.0', '1.4.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.4.0-beta.1', '1.3.9')).toBeGreaterThan(0);
  });

  it('pads missing parts with zero', () => {
    expect(compareVersions('1.4', '1.4.0')).toBe(0);
  });
});

describe('shouldNotify', () => {
  const base = { available: '1.4.0', current: '1.3.5', skipped: null, laterVersion: null, enabled: true };

  it('notifies about a newer version', () => {
    expect(shouldNotify(base)).toBe(true);
  });

  it('never offers the same or an older version', () => {
    expect(shouldNotify({ ...base, available: '1.3.5' })).toBe(false);
    expect(shouldNotify({ ...base, available: '1.3.4' })).toBe(false);
  });

  it('stays quiet when nothing is available or checks are off', () => {
    expect(shouldNotify({ ...base, available: null })).toBe(false);
    expect(shouldNotify({ ...base, enabled: false })).toBe(false);
  });

  it('a skipped version suppresses only that version', () => {
    expect(shouldNotify({ ...base, skipped: '1.4.0' })).toBe(false);
    expect(shouldNotify({ ...base, skipped: '1.4.0', available: '1.4.1' })).toBe(true);
  });

  it('Later hides that version for the session, but not a newer one', () => {
    expect(shouldNotify({ ...base, laterVersion: '1.4.0' })).toBe(false);
    expect(shouldNotify({ ...base, laterVersion: '1.4.0', available: '1.5.0' })).toBe(true);
  });
});

describe('downloadPercent', () => {
  it('rounds down and caps at 100', () => {
    expect(downloadPercent(50, 200)).toBe(25);
    expect(downloadPercent(999, 1000)).toBe(99);
    expect(downloadPercent(300, 200)).toBe(100);
  });

  it('is null when the size is unknown', () => {
    expect(downloadPercent(10, undefined)).toBeNull();
    expect(downloadPercent(10, 0)).toBeNull();
  });
});

describe('busyMessage', () => {
  it('names what is running and where', () => {
    expect(busyMessage([{ project: 'jaffle_shop', label: 'dbt build' }])).toBe(
      'Updating restarts wickd and will stop dbt build in jaffle_shop.',
    );
  });

  it('lists several activities', () => {
    expect(busyMessage([
      { project: 'jaffle_shop', label: 'dbt build' },
      { project: null, label: 'global setup' },
    ])).toBe('Updating restarts wickd and will stop: dbt build in jaffle_shop; global setup.');
  });
});
