/** Pure theme helpers (unit-tested in themePreference.test.ts). */

export type ResolvedTheme = 'dark' | 'light';
/** What the user picked: a fixed theme, or follow the OS ('system'). */
export type ThemePreference = ResolvedTheme | 'system';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'dark', 'light'];
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';

export function parseThemePreference(value: unknown): ThemePreference | null {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
    ? (value as ThemePreference)
    : null;
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}

export function themeLabel(pref: ThemePreference): string {
  if (pref === 'system') return 'System';
  return pref === 'dark' ? 'Dark' : 'Light';
}
