import type { ExportFormat, ExportTheme, HtmlIncludes } from './config';

const PREFS_KEY = 'wickd:dag-export-prefs';

/** The export modal's last choices, so the next export starts where this one left off. */
export interface ExportPrefs {
  format: ExportFormat;
  theme: ExportTheme;
  includes: HtmlIncludes;
  /** Empty → the backend's default (~/Downloads). */
  directory: string;
}

export const DEFAULT_PREFS: ExportPrefs = {
  format: 'html',
  theme: 'dark',
  includes: { modelLineage: true, columnLineage: true, wholeProject: true },
  directory: '',
};

const FORMATS: ExportFormat[] = ['html', 'svg', 'png'];
const THEMES: ExportTheme[] = ['dark', 'light'];

/** Validates stored JSON field by field; anything unexpected falls back to the default. */
export function parsePrefs(raw: string | null): ExportPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const obj = JSON.parse(raw) as Partial<Record<keyof ExportPrefs, unknown>>;
    const inc = (obj.includes ?? {}) as Partial<Record<keyof HtmlIncludes, unknown>>;
    return {
      format: FORMATS.includes(obj.format as ExportFormat) ? (obj.format as ExportFormat) : DEFAULT_PREFS.format,
      theme: THEMES.includes(obj.theme as ExportTheme) ? (obj.theme as ExportTheme) : DEFAULT_PREFS.theme,
      includes: {
        modelLineage: typeof inc.modelLineage === 'boolean' ? inc.modelLineage : DEFAULT_PREFS.includes.modelLineage,
        columnLineage: typeof inc.columnLineage === 'boolean' ? inc.columnLineage : DEFAULT_PREFS.includes.columnLineage,
        wholeProject: typeof inc.wholeProject === 'boolean' ? inc.wholeProject : DEFAULT_PREFS.includes.wholeProject,
      },
      directory: typeof obj.directory === 'string' ? obj.directory : '',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function loadPrefs(): ExportPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: ExportPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}
