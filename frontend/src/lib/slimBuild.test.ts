import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { apiErrorMessage, buildOpts, canClone, commandLine, deferLabel, slimSettings } from './slimBuild';

describe('slimSettings', () => {
  it('reads the source, defer mode and base target from project env vars', () => {
    expect(slimSettings([])).toEqual({ source: '', defer: 'off', baseTarget: '' });
    expect(slimSettings([
      { key: 'STATE_SOURCE', value: 'path:/srv/prod' },
      { key: 'state_defer', value: 'favor' },
      { key: 'DIFF_BASE_TARGET', value: 'prod' },
    ])).toEqual({ source: 'path:/srv/prod', defer: 'favor', baseTarget: 'prod' });
    expect(slimSettings([{ key: 'state_defer', value: 'nonsense' }]).defer).toBe('off');
  });
});

describe('deferLabel', () => {
  it('names the base target, or the folder for path sources', () => {
    expect(deferLabel({ source: '', defer: 'defer', baseTarget: 'prod' })).toBe('Deferring to prod');
    expect(deferLabel({ source: 'git:main', defer: 'defer', baseTarget: '' })).toBe('Deferring to the state manifest');
    expect(deferLabel({ source: 'path:/srv/prod-artifacts/', defer: 'defer', baseTarget: '' })).toBe('Deferring to prod-artifacts');
  });
});

describe('apiErrorMessage', () => {
  it('prefers the detail text or message', () => {
    expect(apiErrorMessage(new ApiError(409, '', 'retry only works on the last run.'), 'x')).toBe('retry only works on the last run.');
    expect(apiErrorMessage(new ApiError(400, '', { message: 'no manifest' }), 'x')).toBe('no manifest');
    expect(apiErrorMessage(null, 'fallback')).toBe('fallback');
  });
});

describe('canClone', () => {
  it('allows tables, incrementals and snapshots', () => {
    expect(canClone('model', 'table')).toBe(true);
    expect(canClone('model', 'incremental')).toBe(true);
    expect(canClone('model', 'view')).toBe(false);
    expect(canClone('snapshot', null)).toBe(true);
    expect(canClone('seed', 'seed')).toBe(false);
  });
});

describe('commandLine', () => {
  it('spells out the dbt command a build runs', () => {
    expect(commandLine({ select: 'orders+', defer: 'off' })).toBe('dbt build --select orders+');
    expect(commandLine({ select: 'state:modified+', statePath: '/s/active', deferPath: '/s/prod', defer: 'favor', target: 'dev' }))
      .toBe('dbt build --select state:modified+ --state /s/active --defer --defer-state /s/prod --favor-state --target dev');
    expect(commandLine({ select: '', defer: 'off' })).toBe('dbt build --select (nothing)');
  });
});

describe('buildOpts', () => {
  it('passes --state only for state selectors, and the chosen defer mode', () => {
    expect(buildOpts(true, 'off')).toEqual({ state: true, defer: false, favor_state: false });
    expect(buildOpts(false, 'favor')).toEqual({ state: undefined, defer: true, favor_state: true });
  });
});
