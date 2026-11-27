import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi';

describe('stripAnsi', () => {
  it('removes color and reset codes from a dbt result line', () => {
    expect(stripAnsi('\x1b[0m18:30:48  1 of 1 PASS my_test ..... [\x1b[32mPASS\x1b[0m in 0.02s]'))
      .toBe('18:30:48  1 of 1 PASS my_test ..... [PASS in 0.02s]');
  });

  it('removes multi-parameter codes', () => {
    expect(stripAnsi('\x1b[1;31mERROR\x1b[0m')).toBe('ERROR');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('Done. PASS=1 WARN=0')).toBe('Done. PASS=1 WARN=0');
  });
});
