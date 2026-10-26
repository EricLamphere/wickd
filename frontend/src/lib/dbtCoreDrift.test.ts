import { describe, expect, it } from 'vitest';
import { dbtCoreDrift } from './dbtCoreDrift';

const status = (over: object) => ({
  installed: true, version: '1.12.6', expected: 'dbt-core==1.10.13', expected_source: 'setting' as const, matches: false, ...over,
});

describe('dbtCoreDrift', () => {
  it('explains a drift from the version chosen in setup', () => {
    expect(dbtCoreDrift(status({}))).toEqual({
      title: 'dbt-core 1.12.6 is installed, not the 1.10.13 you chose',
      detail: expect.stringContaining('WICKD_DBT_CORE_VERSION'),
    });
  });

  it('explains a drift from the requirements file', () => {
    const drift = dbtCoreDrift(status({ expected: 'dbt-core>=1.8,<1.11', expected_source: 'requirements' }));
    expect(drift?.title).toBe('dbt-core 1.12.6 is installed, but your requirements file asks for dbt-core>=1.8,<1.11');
  });

  it('says nothing when it matches, there is nothing to compare, or dbt is missing', () => {
    expect(dbtCoreDrift(status({ matches: true }))).toBeNull();
    expect(dbtCoreDrift(status({ matches: null }))).toBeNull();
    expect(dbtCoreDrift(status({ installed: false, version: null, matches: null }))).toBeNull();
    expect(dbtCoreDrift(undefined)).toBeNull();
  });
});
