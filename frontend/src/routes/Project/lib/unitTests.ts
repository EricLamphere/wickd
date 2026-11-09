/** dbt unit tests in the UI (plan 19): which belong to a model, how a failure's diff is
 *  shown, and which focus option a Files selection points at. Pure. */
import type { GraphDto, ModelNode, UnitTestDiffDto, UnitTestDto } from '../../../lib/api';
import type { UnitTestFileOptions, UnitTestFocusOption } from '../../../lib/aiApi';

export const FAILED = new Set(['error', 'fail']);

export function unitTestsOf(graph: GraphDto | null | undefined, model: ModelNode): UnitTestDto[] {
  return (graph?.unit_tests ?? []).filter((u) =>
    u.model_unique_id ? u.model_unique_id === model.unique_id : u.model === model.name);
}

export interface UnitTestBadge {
  count: number;
  failed: number;
}

/** Per model unique_id: how many unit tests it has and how many failed last run. */
export function unitTestBadges(graph: GraphDto | null | undefined): Map<string, UnitTestBadge> {
  const byName = new Map((graph?.nodes ?? []).filter((n) => n.resource_type === 'model').map((n) => [n.name, n.unique_id]));
  const out = new Map<string, UnitTestBadge>();
  for (const u of graph?.unit_tests ?? []) {
    const uid = u.model_unique_id ?? (u.model ? byName.get(u.model) : undefined);
    if (!uid) continue;
    const prev = out.get(uid) ?? { count: 0, failed: 0 };
    out.set(uid, { count: prev.count + 1, failed: prev.failed + (FAILED.has(u.status ?? '') ? 1 : 0) });
  }
  return out;
}

/** `dbt test --select` for a model's unit tests, or one of them. */
export function unitTestSelector(name: string): string {
  return `${name},test_type:unit`;
}

export interface DiffDisplay {
  columns: string[];
  rows: unknown[][];
  /** per row, per column (including the leading marker column): a highlight class or '' */
  classes: string[][];
}

const ROW_LABEL: Record<string, string> = { same: '', changed: '≠', added: '+ actual', removed: '− expected' };
const ROW_CLASS: Record<string, string> = {
  added: 'bg-emerald-950/40 text-emerald-300',
  removed: 'bg-red-950/40 text-red-300',
};
const CHANGED_CELL = 'bg-amber-950/50 text-amber-200';

function show(value: string | null): string {
  return value === null ? 'NULL' : value;
}

/** The diff as a table: a marker column, then each column; a changed cell reads
 *  `expected → actual`. Rows only in actual / only in expected are tinted. */
export function diffDisplay(diff: UnitTestDiffDto): DiffDisplay {
  const rows: unknown[][] = [];
  const classes: string[][] = [];
  for (const row of diff.rows) {
    const cells: unknown[] = [ROW_LABEL[row.status] ?? ''];
    const tint: string[] = [ROW_CLASS[row.status] ?? ''];
    diff.columns.forEach((_, i) => {
      const expected = row.expected?.[i] ?? null;
      const actual = row.actual?.[i] ?? null;
      if (row.status === 'changed' && expected !== actual) {
        cells.push(`${show(expected)} → ${show(actual)}`);
        tint.push(CHANGED_CELL);
      } else {
        cells.push(show(row.status === 'removed' ? expected : actual));
        tint.push(ROW_CLASS[row.status] ?? '');
      }
    });
    rows.push(cells);
    classes.push(tint);
  }
  return { columns: ['', ...diff.columns], rows, classes };
}

export function diffCounts(diff: UnitTestDiffDto): { changed: number; added: number; removed: number } {
  const count = (s: string) => diff.rows.filter((r) => r.status === s).length;
  return { changed: count('changed'), added: count('added'), removed: count('removed') };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The CTE whose body `before` ends inside: the last `name as (` still open at its end. */
export function enclosingCte(before: string): string | null {
  const defs = [...before.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi)];
  for (const def of defs.reverse()) {
    let depth = 1;
    for (const ch of before.slice((def.index ?? 0) + def[0].length)) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      if (depth === 0) break;
    }
    if (depth > 0) return def[1];
  }
  return null;
}

/** The focus option a selected piece of SQL is about: a CASE column it aliases, a CTE it
 *  defines or names, else (with `before`, the file's text before the selection) the CTE
 *  it sits in; null when nothing matches. */
export function focusFromSelection(options: UnitTestFocusOption[], selection: string, before = ''): string | null {
  const text = selection.trim();
  const named = (o: UnitTestFocusOption) => new RegExp(`\\b${escapeRegExp(o.id.split(':').slice(1).join(':'))}\\b`, 'i');
  if (text) {
    const hasCase = /\bcase\b/i.test(text);
    const cases = options.filter((o) => o.kind === 'case' && named(o).test(text));
    if (hasCase && cases.length > 0) return cases[0].id;
    const defined = options.find((o) => o.kind === 'cte'
      && new RegExp(`\\b${escapeRegExp(o.id.slice(4))}\\s+as\\s*\\(`, 'i').test(text));
    if (defined) return defined.id;
    if (cases[0]) return cases[0].id;
  }
  const inside = before ? enclosingCte(before) : null;
  const cte = inside ? options.find((o) => o.id.toLowerCase() === `cte:${inside.toLowerCase()}`) : undefined;
  if (cte) return cte.id;
  return text ? options.find((o) => named(o).test(text))?.id ?? null : null;
}

/** The path the backend will write for what was typed (files.resolve_file): a bare
 *  name goes in the model's folder, `.yml` is added without a YAML suffix. */
export function resolveFileInput(input: string, modelDir: string): string {
  const text = input.trim().replace(/\\/g, '/');
  if (!text) return '';
  const path = text.includes('/') ? text : `${modelDir}/${text}`;
  return /\.ya?ml$/i.test(path) ? path : `${path}.yml`;
}

export interface FileChoice {
  /** '' = the default location */
  value: string;
  label: string;
}

/** The Write to list: the default, this model's unit test files, then the file remembered
 *  for this model (when it's none of those); "another file" is offered separately. */
export function fileChoices(options: UnitTestFileOptions, remembered: string | null): FileChoice[] {
  const choices: FileChoice[] = [{ value: '', label: `Default · ${options.default}` }];
  const add = (path: string, why: string) => {
    if (path && path !== options.default && !choices.some((c) => c.value === path)) choices.push({ value: path, label: `${path} · ${why}` });
  };
  options.existing.forEach((p) => add(p, 'has unit tests'));
  if (remembered) add(remembered, options.files.includes(remembered) ? 'last used' : 'last used, new file');
  return choices;
}

/** localStorage key for the file last chosen for a model's unit tests. */
export function unitTestFileKey(projectId: number, uniqueId: string): string {
  return `wickd:unit-test-file:${projectId}:${uniqueId}`;
}
