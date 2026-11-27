import { describe, expect, it } from 'vitest';
import { runLogFilename, runLogText } from './runLog';

describe('runLogText', () => {
  it('puts the command first and strips color codes', () => {
    expect(runLogText('dbt test -s x', ['\x1b[0m18:30:48  [\x1b[32mPASS\x1b[0m in 0.02s]']))
      .toBe('$ dbt test -s x\n\n18:30:48  [PASS in 0.02s]\n');
  });

  it('is just the lines without a command, and empty without either', () => {
    expect(runLogText(null, ['a', 'b'])).toBe('a\nb\n');
    expect(runLogText(null, [])).toBe('');
  });
});

describe('runLogFilename', () => {
  it('slugs the command', () => {
    expect(runLogFilename('build', 42)).toBe('dbt-build-run-42');
    expect(runLogFilename('run-operation', 7)).toBe('dbt-run-operation-run-7');
    expect(runLogFilename('source freshness', 3)).toBe('dbt-source-freshness-run-3');
    expect(runLogFilename('', 1)).toBe('dbt-run-run-1');
  });
});
