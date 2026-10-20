import type { AiProposalDto, AiSuggestedTest } from '../../../../lib/aiApi';
import { describeTest } from '../../../../lib/partialTests';

/** One separately acceptable piece of a proposal: a test, or a description. */
export interface ProposalItem {
  key: string;
  /** Column (or "Model description"). */
  title: string;
  detail: string;
  test?: AiSuggestedTest;
}

export function proposalItems(p: AiProposalDto): ProposalItem[] {
  if (p.kind === 'tests') {
    return (p.result.tests ?? [])
      .filter((t) => t.key)
      .map((t) => ({ key: t.key!, title: t.column, detail: describeTest(t), test: t }));
  }
  const items: ProposalItem[] = [];
  if (p.result.description) items.push({ key: 'description', title: 'Model description', detail: p.result.description });
  for (const [name, text] of Object.entries(p.result.columns ?? {})) {
    items.push({ key: `col:${name}`, title: name, detail: text });
  }
  return items;
}

/** Keys currently included in the proposed file (all of them until the user changes it). */
export function selectedKeys(p: AiProposalDto): Set<string> {
  return new Set(p.result.selected ?? proposalItems(p).map((i) => i.key));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where an item sits: the entry it belongs to, and the line to find inside it. */
function locator(p: AiProposalDto, item: ProposalItem): { anchor: string; marker: RegExp; direct: boolean } {
  if (item.test) {
    return { anchor: item.test.column, marker: new RegExp(`^\\s*-\\s*${escapeRegExp(item.test.test)}\\b`), direct: false };
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
  const { anchor, marker, direct } = locator(p, item);
  if (!anchor) return null;
  const lines = text.split('\n');
  const nameRe = new RegExp(`^(\\s*(?:-\\s+)?)name:\\s*["']?${escapeRegExp(anchor)}["']?\\s*(#.*)?$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = nameRe.exec(lines[i]);
    if (!m) continue;
    const keyCol = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const dashed = /^\s*-\s/.test(line);
      if (indent < keyCol || (dashed && indent <= keyCol - 2)) break; // left the entry
      if (marker.test(line) && (!direct || indent === keyCol)) return j + 1;
    }
  }
  return null;
}
