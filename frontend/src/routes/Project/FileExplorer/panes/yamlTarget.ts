// Locates the part of a YAML file a deep link points at (a test, unit test, metric,
// semantic model, saved query, source table, exposure, model entry or column), so
// the Files editor can scroll to it and highlight it briefly.
import type { GraphDto, ModelNode } from '../../../../lib/api';
import { findUnitTestLine } from './unitTestLine';

/** 1-based, inclusive line range. */
export interface LineRange { start: number; end: number }

export type YamlTarget =
  | { kind: 'test'; testMetadataName: string | null; columnName: string | null; attachedNode: string | null }
  | { kind: 'unit_test'; name: string }
  /** `- name: <name>` under `<section>:`, inside `parent` when given (source tables), then `column` inside it */
  | { kind: 'entry'; section: string; name: string; parent?: { section: string; name: string }; column?: string | null };

/** The top-level YAML key each YAML-defined resource type lives under. */
const SECTION_BY_TYPE: Record<string, string> = {
  model: 'models',
  seed: 'seeds',
  snapshot: 'snapshots',
  analysis: 'analyses',
  metric: 'metrics',
  semantic_model: 'semantic_models',
  saved_query: 'saved_queries',
  exposure: 'exposures',
  macro: 'macros',
};

const isYaml = (path: string) => path.endsWith('.yml') || path.endsWith('.yaml');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === '' || line.trimStart().startsWith('#');

/** Last line (0-based) of the list item or key starting at `start`: every following line indented deeper. */
export function blockEnd(lines: string[], start: number): number {
  const base = indentOf(lines[start]);
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= base) break;
    end = i;
  }
  return end;
}

/** 0-based [from, to] of the block under `<section>:` within [from, to], or null. */
function findSection(lines: string[], section: string, from: number, to: number): [number, number] | null {
  const key = new RegExp(`^\\s*${escapeRegExp(section)}:\\s*(#.*)?$`);
  for (let i = from; i <= to; i++) {
    if (!key.test(lines[i])) continue;
    const base = indentOf(lines[i]);
    let end = i;
    for (let j = i + 1; j <= to; j++) {
      if (isBlank(lines[j])) continue;
      const ind = indentOf(lines[j]);
      // YAML lets a list sit at its key's indent ("models:\n- name: x")
      if (ind < base || (ind === base && !lines[j].trimStart().startsWith('-'))) break;
      end = j;
    }
    return end > i ? [i + 1, end] : null;
  }
  return null;
}

/** 0-based line of the `-` that starts the list item named `name` within [from, to], or null. */
function findItem(lines: string[], name: string, from: number, to: number): number | null {
  const nameLine = new RegExp(`^(\\s*)(-\\s+)?name:\\s*["']?${escapeRegExp(name)}["']?\\s*(#.*)?$`);
  let itemIndent: number | null = null;
  for (let i = from; i <= to; i++) {
    if (isBlank(lines[i])) continue;
    if (itemIndent === null && lines[i].trimStart().startsWith('-')) itemIndent = indentOf(lines[i]);
    const m = nameLine.exec(lines[i]);
    if (!m) continue;
    if (m[2]) {
      if (itemIndent === null || indentOf(lines[i]) === itemIndent) return i;
      continue;
    }
    // `name:` isn't the item's first key: walk back to its `-`
    const keyIndent = m[1].length;
    for (let j = i - 1; j >= from; j--) {
      if (isBlank(lines[j])) continue;
      const ind = indentOf(lines[j]);
      if (lines[j].trimStart().startsWith('-') && ind < keyIndent) {
        if (itemIndent === null || ind === itemIndent) return j;
        break;
      }
      if (ind < keyIndent) break;
    }
  }
  return null;
}

/** The item `name` under `section` inside [from, to]; anywhere in the range when that fails. */
function findEntry(lines: string[], section: string, name: string, from: number, to: number): [number, number] | null {
  const block = findSection(lines, section, from, to);
  const start = (block && findItem(lines, name, block[0], block[1])) ?? findItem(lines, name, from, to);
  return start === null ? null : [start, blockEnd(lines, start)];
}

function toRange(start: number, end: number): LineRange {
  return { start: start + 1, end: end + 1 };
}

/**
 * For a YAML schema file, find the 1-based line number where a test is defined.
 * Searches for: model name block → column name block (if column_name) → test type.
 * Falls back to a simple text search for the test type name if the structured search fails.
 */
export function findTestLineInYaml(
  content: string,
  testMetadataName: string | null,
  columnName: string | null,
  attachedNode: string | null,
): number | null {
  if (!testMetadataName) return null;
  const lines = content.split('\n');
  const modelName = attachedNode ? attachedNode.split('.').pop() ?? null : null;

  let inModelBlock = modelName === null;
  let inColumnBlock = columnName === null;
  let modelIndent = -1;
  let columnIndent = -1;
  const nameOf = (trimmed: string) => trimmed.match(/^-?\s*name:\s*(.+)$/)?.[1].trim() ?? null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (modelName && !inModelBlock && nameOf(trimmed) === modelName) {
      inModelBlock = true;
      modelIndent = indent;
      continue;
    }
    if (inModelBlock && modelName && indent <= modelIndent && trimmed.startsWith('-')) {
      const n = nameOf(trimmed);
      if (n !== null && n !== modelName) {
        inModelBlock = false;
        inColumnBlock = columnName === null;
        modelIndent = -1;
        columnIndent = -1;
        continue;
      }
    }
    if (!inModelBlock) continue;

    if (columnName && !inColumnBlock && nameOf(trimmed) === columnName) {
      inColumnBlock = true;
      columnIndent = indent;
      continue;
    }
    if (inColumnBlock && columnName && indent <= columnIndent && trimmed.startsWith('-')) {
      const n = nameOf(trimmed);
      if (n !== null && n !== columnName) {
        inColumnBlock = false;
        columnIndent = -1;
        continue;
      }
    }
    if (!inColumnBlock) continue;

    // "- <testName>", "- <testName>:" or "- name: <testName>"
    const testSimple = trimmed.match(/^-\s*(\w+)\s*(?::|$)/);
    const testNamed = trimmed.match(/^-?\s*name:\s*(\w+)\s*$/);
    const matched = testSimple ? testSimple[1] : testNamed ? testNamed[1] : null;
    if (matched && matched === testMetadataName) return i + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed === `- ${testMetadataName}` || trimmed.startsWith(`- ${testMetadataName}:`)) return i + 1;
  }
  return null;
}

/** The lines a target covers in `content`, or null when it isn't there. */
export function findYamlTargetRange(content: string, target: YamlTarget): LineRange | null {
  const lines = content.split('\n');
  if (target.kind === 'test' || target.kind === 'unit_test') {
    const line = target.kind === 'test'
      ? findTestLineInYaml(content, target.testMetadataName, target.columnName, target.attachedNode)
      : findUnitTestLine(content, target.name);
    return line === null ? null : toRange(line - 1, blockEnd(lines, line - 1));
  }

  let scope: [number, number] = [0, lines.length - 1];
  if (target.parent) {
    const parent = findEntry(lines, target.parent.section, target.parent.name, scope[0], scope[1]);
    if (!parent) return null;
    scope = parent;
  }
  const entry = findEntry(lines, target.section, target.name, scope[0], scope[1]);
  if (!entry) return null;
  if (!target.column) return toRange(entry[0], entry[1]);
  const column = findEntry(lines, 'columns', target.column, entry[0], entry[1]);
  return toRange(...(column ?? entry));
}

/**
 * What a Files deep link (`?model=<unique_id>`, optional `?column=`) points at inside
 * the open file, when that file is YAML. Null for a SQL file or an unknown node.
 */
export function yamlTargetFor(
  graph: GraphDto,
  path: string,
  uid: string | null,
  column: string | null = null,
): YamlTarget | null {
  if (!uid || !isYaml(path)) return null;
  const unitTest = graph.unit_tests?.find((u) => u.unique_id === uid);
  if (unitTest) return { kind: 'unit_test', name: unitTest.name };
  const node: ModelNode | undefined = graph.nodes.find((n) => n.unique_id === uid);
  if (!node) return null;
  if (node.resource_type === 'test') {
    return { kind: 'test', testMetadataName: node.test_metadata_name, columnName: node.column_name, attachedNode: node.attached_node };
  }
  if (node.resource_type === 'source') {
    if (!node.source_name) return null;
    return { kind: 'entry', section: 'tables', name: node.name, parent: { section: 'sources', name: node.source_name }, column };
  }
  const section = SECTION_BY_TYPE[node.resource_type];
  return section ? { kind: 'entry', section, name: node.name, column } : null;
}
