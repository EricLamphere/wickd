import { describe, expect, it } from 'vitest';
import type { CheckSummary, HealthSummary } from '../../../../lib/api';
import { navAlert, tabBadge } from './healthStatus';

const check = (over: Partial<CheckSummary>): CheckSummary => ({
  status: 'ok', headline: '', issues: 0, finished_at: null, target: null, stale_reasons: [], ...over,
});

describe('tabBadge', () => {
  it('shows the issue count for warn/fail', () => {
    expect(tabBadge(check({ status: 'warn', issues: 3 }))).toEqual({ label: '3', tone: 'warn' });
    expect(tabBadge(check({ status: 'fail', issues: 0 }))).toEqual({ label: '!', tone: 'fail' });
  });
  it('shows a dot for running and nothing when ok or not run', () => {
    expect(tabBadge(check({ status: 'running' }))).toEqual({ label: null, tone: 'running' });
    expect(tabBadge(check({ status: 'ok' }))).toBeNull();
    expect(tabBadge(check({ status: 'not_run' }))).toBeNull();
  });
});

describe('navAlert', () => {
  const summary = (c: CheckSummary, d: CheckSummary, f: CheckSummary): HealthSummary =>
    ({ connection: c, drift: d, freshness: f, current_target: null });

  it('is the worst status across checks', () => {
    expect(navAlert(summary(check({}), check({ status: 'warn' }), check({ status: 'fail' })))).toBe('fail');
    expect(navAlert(summary(check({}), check({ status: 'warn' }), check({})))).toBe('warn');
  });
  it('is null when nothing is wrong (running and not run are not alerts)', () => {
    expect(navAlert(summary(check({ status: 'running' }), check({ status: 'not_run' }), check({})))).toBeNull();
    expect(navAlert(undefined)).toBeNull();
  });
});
