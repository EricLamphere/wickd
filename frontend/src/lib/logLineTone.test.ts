import { describe, expect, it } from 'vitest';
import { logLineTone } from './logLineTone';

describe('logLineTone — dbt summary lines', () => {
  it('is green when nothing failed, warned or skipped', () => {
    expect(logLineTone('Done. PASS=2 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=2')).toBe('success');
    expect(logLineTone('12:01:02  Done. PASS=2 WARN=0 ERROR=0 SKIP=0 TOTAL=2')).toBe('success');
  });

  it('is red when ERROR > 0, even with warnings', () => {
    expect(logLineTone('Done. PASS=1 WARN=3 ERROR=1 SKIP=2 NO-OP=0 TOTAL=7')).toBe('error');
  });

  it('is amber when WARN or SKIP > 0 and no errors', () => {
    expect(logLineTone('Done. PASS=1 WARN=1 ERROR=0 SKIP=0 TOTAL=2')).toBe('warn');
    expect(logLineTone('Done. PASS=1 WARN=0 ERROR=0 SKIP=4 TOTAL=5')).toBe('warn');
  });

  it('reads the "Completed with …" line by its counts', () => {
    expect(logLineTone('Completed with 1 error, 0 partial successes, and 0 warnings:')).toBe('error');
    expect(logLineTone('Completed with 0 errors, 0 partial successes, and 2 warnings:')).toBe('warn');
    expect(logLineTone('Completed successfully')).toBe('success');
  });
});

describe('logLineTone — other lines', () => {
  it('flags per-node failures and errors', () => {
    expect(logLineTone('1 of 3 ERROR creating sql view model main.stg_a ... [ERROR in 0.05s]')).toBe('error');
    expect(logLineTone('2 of 3 FAIL 4 not_null_orders_id ... [FAIL 4 in 0.02s]')).toBe('error');
    expect(logLineTone('Runtime Error in model stg_a')).toBe('error');
  });

  it('flags warnings and successes', () => {
    expect(logLineTone('3 of 3 WARN 1 unique_orders_id ... [WARN 1 in 0.01s]')).toBe('warn');
    expect(logLineTone('1 of 3 OK created sql view model main.stg_a ... [OK in 0.05s]')).toBe('success');
    expect(logLineTone('2 of 3 PASS not_null_orders_id ... [PASS in 0.02s]')).toBe('success');
  });

  it('marks section dividers and leaves the rest plain', () => {
    expect(logLineTone('>>> dbt run')).toBe('accent');
    expect(logLineTone('Found 14 models, 5 seeds')).toBeNull();
  });

  it('does not treat ERROR=0 anywhere as an error', () => {
    expect(logLineTone('PASS=5 WARN=0 ERROR=0')).toBe('success');
  });
});
