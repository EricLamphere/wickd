// The metric whose definition holds the cursor in a dbt YAML file (Files → Add metric note…):
// an item of a top-level-ish `metrics:` list, `- name: revenue`, and everything indented under it.
// Pure; tested in yamlMetric.test.ts.

const ITEM = /^(\s*)-\s+(.*)$/;
const NAME = /^name:\s*['"]?([A-Za-z0-9_]+)['"]?\s*(#.*)?$/;
const KEY = /^(\s*)([A-Za-z0-9_]+):\s*(#.*)?$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function blank(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** The item's `name:` (on the dash line, or the first line of its block), else null. */
function itemName(lines: string[], at: number, indent: number): string | null {
  const first = ITEM.exec(lines[at])?.[2] ?? '';
  const own = NAME.exec(first.trim());
  if (own) return own[1];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (blank(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) return null;
    const m = NAME.exec(lines[i].trim());
    if (m && indentOf(lines[i]) === indent + 2) return m[1];
  }
  return null;
}

/** The list key (`metrics`) an item at `indent` belongs to, walking up from `at`. */
function parentKey(lines: string[], at: number, indent: number): string | null {
  for (let i = at - 1; i >= 0; i -= 1) {
    if (blank(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < indent || (ind === indent && !ITEM.test(lines[i]))) return KEY.exec(lines[i])?.[2] ?? null;
  }
  return null;
}

/** `line` is 1-based (Monaco's). */
export function metricAtLine(text: string, line: number): string | null {
  const lines = text.split(/\r?\n/);
  const cursor = Math.min(Math.max(line - 1, 0), lines.length - 1);
  let floor = Infinity; // the smallest indent seen between the cursor and the item
  for (let i = cursor; i >= 0; i -= 1) {
    if (blank(lines[i])) continue;
    const ind = indentOf(lines[i]);
    const item = ITEM.exec(lines[i]);
    // an item enclosing the cursor (less indented than everything below it); a nested list's
    // item (a metric's filter list, say) isn't under `metrics:`, so keep walking up
    if (item && ind < floor && parentKey(lines, i, ind) === 'metrics') return itemName(lines, i, ind);
    floor = Math.min(floor, ind);
    if (ind === 0 && !item) return null;
  }
  return null;
}
