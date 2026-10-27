import type { AiProposalDto, AiSuggestedTest, PropagationItem } from '../../../../lib/aiApi';
import { describeTest, testSubject, testWhy } from '../../../../lib/partialTests';

/** One separately acceptable piece of a proposal: a test, a description, or inherited tags. */
export interface ProposalItem {
  key: string;
  /** Column (or "Model description"; "model.column" for lineage propagation). */
  title: string;
  detail: string;
  /** Shown under the item: why it was suggested (e.g. lineage evidence for a test). */
  why?: string;
  test?: AiSuggestedTest;
  /** Lineage propagation / batch tests: the item's schema file. */
  file?: string;
  propagation?: PropagationItem;
}

const KIND_LABELS: Record<string, string> = { identity: 'same column', rename: 'renamed', cast: 'cast', derived: 'derived' };

function propagationDetail(item: PropagationItem): string {
  if (item.field === 'tags') {
    return (item.tags ?? []).map((t) => `+${t}${item.via_kind?.[t] === 'derived' ? ' (derived)' : ''}`).join(' ');
  }
  const from = item.source ? ` ← ${item.source.node.split('.').pop()}.${item.source.column}` : '';
  const how = item.kind ? ` (${KIND_LABELS[item.kind] ?? item.kind})` : '';
  return `${item.value ?? ''}${from}${how}`;
}

export function proposalItems(p: AiProposalDto): ProposalItem[] {
  if (p.kind === 'propagate') {
    return (p.result.items ?? []).map((i) => ({
      key: i.key, title: `${i.name}.${i.column}`, detail: propagationDetail(i), file: i.file, propagation: i,
    }));
  }
  if (p.kind === 'tests') {
    return (p.result.tests ?? [])
      .filter((t) => t.key)
      .map((t) => ({
        key: t.key!,
        title: t.file && t.name ? `${t.name}.${testSubject(t)}` : testSubject(t),
        detail: describeTest(t),
        why: testWhy(t) || undefined,
        test: t,
        file: t.file,
      }));
  }
  const items: ProposalItem[] = [];
  if (p.result.description) items.push({ key: 'description', title: 'Model description', detail: p.result.description });
  for (const [name, text] of Object.entries(p.result.columns ?? {})) {
    items.push({ key: `col:${name}`, title: name, detail: text });
  }
  return items;
}

/** The items written to `path` (every item, for single-file proposals). */
export function itemsInFile(items: ProposalItem[], path: string | undefined): ProposalItem[] {
  return items.filter((i) => !i.file || i.file === path);
}

/** Keys currently included in the proposed file (all of them until the user changes it). */
export function selectedKeys(p: AiProposalDto): Set<string> {
  return new Set(p.result.selected ?? proposalItems(p).map((i) => i.key));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Locator {
  /** the node entry to look inside first (lineage propagation: many nodes share a file) */
  parent?: string;
  anchor: string;
  marker: RegExp;
  direct: boolean;
}

/** Where an item sits: the entry it belongs to, and the line to find inside it. */
function locator(p: AiProposalDto, item: ProposalItem): Locator {
  if (item.propagation) {
    const marker = item.propagation.field === 'tags' ? /^\s*(-\s+)?tags:/ : /^\s*(-\s+)?description:/;
    return { parent: item.propagation.name, anchor: item.propagation.column, marker, direct: true };
  }
  if (item.test) {
    const testName = item.test.spec?.name ?? item.test.test;
    const marker = new RegExp(`^\\s*-\\s*${escapeRegExp(testName)}\\b`);
    if (!item.test.column) {
      // model-level: under the node's own entry
      return { anchor: item.test.name ?? p.unique_id?.split('.').pop() ?? '', marker, direct: false };
    }
    return { parent: item.test.file ? item.test.name : undefined, anchor: item.test.column, marker, direct: false };
  }
  if (item.key === 'description') {
    return { anchor: p.unique_id?.split('.').pop() ?? '', marker: /^\s*(-\s+)?description:/, direct: true };
  }
  return { anchor: item.title, marker: /^\s*(-\s+)?description:/, direct: true };
}

/**
 * 1-based line of `item` in the proposed file, so the diff can jump to it; null when
 * it isn't there (e.g. the item was rejected). `direct` markers must be keys of the
 * entry itself (same indent as its `name:`), not of something nested in it.
 */
export function findItemLine(text: string, p: AiProposalDto, item: ProposalItem): number | null {
  const { parent, anchor, marker, direct } = locator(p, item);
  if (!anchor) return null;
  const lines = text.split('\n');
  const start = parent ? findEntry(lines, parent, 0, lines.length) : null;
  if (parent && !start) return null;
  const [from, to] = start ? [start.line + 1, entryEnd(lines, start)] : [0, lines.length];
  for (let i = from; i < to; i++) {
    const entry = matchName(lines[i], anchor);
    if (entry === null) continue;
    for (let j = i + 1; j < to; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (leftEntry(line, indent, entry)) break;
      if (marker.test(line) && (!direct || indent === entry)) return j + 1;
    }
  }
  return null;
}

/** The key column of a `name: <anchor>` line, else null. */
function matchName(line: string, anchor: string): number | null {
  const m = new RegExp(`^(\\s*(?:-\\s+)?)name:\\s*["']?${escapeRegExp(anchor)}["']?\\s*(#.*)?$`, 'i').exec(line);
  return m ? m[1].length : null;
}

function leftEntry(line: string, indent: number, keyCol: number): boolean {
  const dashed = /^\s*-\s/.test(line);
  return indent < keyCol || (dashed && indent <= keyCol - 2);
}

function findEntry(lines: string[], name: string, from: number, to: number): { line: number; keyCol: number } | null {
  for (let i = from; i < to; i++) {
    const keyCol = matchName(lines[i], name);
    if (keyCol !== null) return { line: i, keyCol };
  }
  return null;
}

function entryEnd(lines: string[], entry: { line: number; keyCol: number }): number {
  for (let j = entry.line + 1; j < lines.length; j++) {
    const line = lines[j];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (leftEntry(line, line.length - line.trimStart().length, entry.keyCol)) return j;
  }
  return lines.length;
}
