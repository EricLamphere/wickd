// Pure helpers for a custom step's captured env vars; unit-tested in capturedVars.test.ts.

/** Env var names are stored upper-case with anything outside [A-Z0-9_] turned into `_`. */
export function normalizeVarName(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// Matches `export FOO=…`, `export FOO` and lists like `export A=1 B=2`.
const EXPORT_LINE = /^\s*export\s+(.+)$/;
const VAR_TOKEN = /^([A-Za-z_][A-Za-z0-9_]*)(=|$)/;

/**
 * Names the script exports, in first-seen order, so the editor can offer them
 * as one-click captures. Best effort: it reads `export` lines, not the shell's
 * real behaviour, and skips commented-out lines and flags like `export -p`.
 */
export function detectExports(script: string): string[] {
  const found: string[] = [];
  for (const line of script.split('\n')) {
    const match = EXPORT_LINE.exec(line);
    if (!match) continue;
    for (const token of match[1].split(/\s+/)) {
      if (token.startsWith('#')) break;
      const name = VAR_TOKEN.exec(token)?.[1];
      if (name && !found.includes(name)) found.push(name);
      // Only the first token is reliable once a value may contain spaces.
      if (token.includes('=') && /["']/.test(token)) break;
    }
  }
  return found;
}
