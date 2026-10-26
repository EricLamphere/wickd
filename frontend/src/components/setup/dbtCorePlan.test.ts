import { describe, expect, it } from 'vitest';
import { dbtCorePlan } from './dbtCorePlan';

describe('dbtCorePlan', () => {
  it('no file: global setup installs the chosen version', () => {
    expect(dbtCorePlan({ path: '', createFile: true, file: null, version: '1.10.13' })).toEqual({
      kind: 'no-file', showPicker: true, installs: 'dbt-core 1.10.13',
    });
    expect(dbtCorePlan({ path: '  ', createFile: true, file: null, version: '' }).installs).toBe('Latest dbt-core');
  });

  it('a new file starts with the chosen version', () => {
    const plan = dbtCorePlan({ path: '/p/requirements.txt', createFile: true, file: { exists: false, dbt_core_line: null }, version: '1.9.0' });
    expect(plan).toEqual({ kind: 'new-file', showPicker: true, installs: '/p/requirements.txt (dbt-core 1.9.0)' });
  });

  it('an existing file without dbt-core gets it appended', () => {
    const plan = dbtCorePlan({ path: '/p/r.txt', createFile: true, file: { exists: true, dbt_core_line: null }, version: '1.9.0' });
    expect(plan).toEqual({ kind: 'append', showPicker: true, installs: '/p/r.txt (+ dbt-core 1.9.0)' });
  });

  it("an existing file's own dbt-core wins, so no picker", () => {
    const plan = dbtCorePlan({ path: '/p/r.txt', createFile: true, file: { exists: true, dbt_core_line: 'dbt-core>=1.8' }, version: '1.9.0' });
    expect(plan).toEqual({ kind: 'from-file', showPicker: false, installs: '/p/r.txt (dbt-core>=1.8)' });
  });

  it('a missing file that will not be created: no picker (saving reports the error)', () => {
    const plan = dbtCorePlan({ path: '/p/r.txt', createFile: false, file: { exists: false, dbt_core_line: null }, version: '1.9.0' });
    expect(plan.kind).toBe('missing');
    expect(plan.showPicker).toBe(false);
  });

  it('while the file check is loading: no picker yet', () => {
    expect(dbtCorePlan({ path: '/p/r.txt', createFile: true, file: null, version: '1.9.0' })).toEqual({
      kind: 'checking', showPicker: false, installs: '/p/r.txt',
    });
  });
});
