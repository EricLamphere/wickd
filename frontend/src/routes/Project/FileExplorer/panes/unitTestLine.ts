function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 1-based line of a unit test's `- name: <name>` entry: under `unit_tests:` first,
 *  else anywhere in the file; null when it isn't there. */
export function findUnitTestLine(content: string, name: string): number | null {
  const lines = content.split('\n');
  const entry = new RegExp(`^\\s*-\\s*name:\\s*["']?${escapeRegExp(name)}["']?\\s*(#.*)?$`);
  const start = lines.findIndex((l) => /^unit_tests:\s*(#.*)?$/.test(l));
  for (let i = Math.max(start, 0); i < lines.length; i++) {
    if (start >= 0 && i > start && /^\S/.test(lines[i]) && !lines[i].startsWith('-') && !lines[i].startsWith('#')) break;
    if (entry.test(lines[i])) return i + 1;
  }
  const anywhere = lines.findIndex((l) => entry.test(l));
  return anywhere >= 0 ? anywhere + 1 : null;
}
