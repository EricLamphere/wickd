import { useEffect, useState } from 'react';
import {
  DEFAULT_THEME_PREFERENCE,
  parseThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from './themePreference';

export type { ResolvedTheme, ThemePreference } from './themePreference';

export const THEME_CHANGE_EVENT = 'wickd:theme-change';
const STORAGE_KEY = 'wickd-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY).matches : true;
}

/** The theme the user picked (may be 'system'), as remembered locally. */
export function getThemePreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

function setResolvedTheme(theme: ResolvedTheme): void {
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}

/**
 * Apply a theme preference immediately (and remember it locally) — persisting it
 * server-side is the caller's job. `html[data-theme]` always holds the resolved
 * 'dark' / 'light', so everything reading it works unchanged.
 */
export function applyTheme(pref: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // storage unavailable — the theme still applies for this session
  }
  setResolvedTheme(resolveTheme(pref, systemPrefersDark()));
}

/** Apply the saved preference and follow OS light/dark changes while it is 'system'. Call once at startup. */
export function initTheme(): void {
  setResolvedTheme(resolveTheme(getThemePreference(), systemPrefersDark()));
  if (typeof window.matchMedia !== 'function') return;
  window.matchMedia(DARK_QUERY).addEventListener('change', (e) => {
    if (getThemePreference() === 'system') setResolvedTheme(e.matches ? 'dark' : 'light');
  });
}

/** The resolved theme currently shown ('dark' / 'light'), re-rendering when it changes. */
export function useTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(readResolved);

  useEffect(() => {
    const handler = () => setTheme(readResolved());
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handler);
  }, []);

  return theme;
}

function readResolved(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
