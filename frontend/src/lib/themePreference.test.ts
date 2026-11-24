import { describe, expect, it } from 'vitest';
import { parseThemePreference, resolveTheme, themeLabel } from './themePreference';

describe('parseThemePreference', () => {
  it('accepts the three preferences', () => {
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('light')).toBe('light');
  });

  it('rejects anything else', () => {
    expect(parseThemePreference('neon')).toBeNull();
    expect(parseThemePreference(null)).toBeNull();
    expect(parseThemePreference(undefined)).toBeNull();
    expect(parseThemePreference('')).toBeNull();
  });
});

describe('resolveTheme', () => {
  it('follows the OS for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the OS for a fixed theme', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('themeLabel', () => {
  it('labels each preference', () => {
    expect(themeLabel('system')).toBe('System');
    expect(themeLabel('dark')).toBe('Dark');
    expect(themeLabel('light')).toBe('Light');
  });
});
