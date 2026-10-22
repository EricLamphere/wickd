import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, parsePrefs } from './prefs';

describe('parsePrefs', () => {
  it('falls back to the defaults for missing or corrupt data', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('not json')).toEqual(DEFAULT_PREFS);
  });

  it('keeps valid fields and replaces invalid ones', () => {
    const raw = JSON.stringify({ format: 'png', theme: 'neon', includes: { modelLineage: false, columnLineage: 'yes' }, directory: '/tmp' });
    expect(parsePrefs(raw)).toEqual({
      format: 'png',
      theme: 'dark',
      includes: { modelLineage: false, columnLineage: true, wholeProject: true },
      directory: '/tmp',
    });
  });
});
