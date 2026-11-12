// Markdown editing commands for a plain textarea (the dashboard text widget): each takes the
// text and selection and returns the new text and selection, so they're pure and testable.

export interface TextEdit {
  text: string;
  start: number;
  end: number;
}

export type LineFormat = 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'task' | 'quote';

const INDENT = '  ';
const HEADING = /^#{1,6}\s+/;
/** indent, list marker (bullet, number or task), rest of the line */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;
const LIST_PREFIX = /^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/;

/** Start of the first and end of the last line the selection touches. */
function lineSpan(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end);
  return [from, nl === -1 ? text.length : nl];
}

/** Bold (`**`), italic (`_`), strikethrough (`~~`) or code (`` ` ``): wrap the selection, or unwrap it when already wrapped. */
export function toggleWrap(text: string, start: number, end: number, marker: string): TextEdit {
  const m = marker.length;
  const selected = text.slice(start, end);
  if (text.slice(start - m, start) === marker && text.slice(end, end + m) === marker) {
    return { text: text.slice(0, start - m) + selected + text.slice(end + m), start: start - m, end: end - m };
  }
  if (selected.length >= 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(m, -m);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  return { text: text.slice(0, start) + marker + selected + marker + text.slice(end), start: start + m, end: end + m };
}

/** `[selection](url)` with "url" selected, ready to type over. */
export function insertLink(text: string, start: number, end: number): TextEdit {
  const label = text.slice(start, end) || 'link';
  const before = `${text.slice(0, start)}[${label}](`;
  return { text: `${before}url)${text.slice(end)}`, start: before.length, end: before.length + 3 };
}

/** Replace the selected lines with `lines`, keeping a caret on the same line or selecting the block. */
function replaceLines(text: string, start: number, end: number, map: (lines: string[]) => string[]): TextEdit {
  const [from, to] = lineSpan(text, start, end);
  const before = text.slice(from, to).split('\n');
  const after = map(before);
  const block = after.join('\n');
  const next = text.slice(0, from) + block + text.slice(to);
  if (start === end && before.length === 1) {
    const caret = Math.max(from, Math.min(from + block.length, start + after[0].length - before[0].length));
    return { text: next, start: caret, end: caret };
  }
  return { text: next, start: from, end: from + block.length };
}

/** Tab / Shift+Tab: indent or outdent every selected line by two spaces. */
export function indentLines(text: string, start: number, end: number, outdent: boolean): TextEdit {
  return replaceLines(text, start, end, (lines) => lines.map((l) => {
    if (!outdent) return INDENT + l;
    if (l.startsWith(INDENT)) return l.slice(INDENT.length);
    return l.startsWith(' ') || l.startsWith('\t') ? l.slice(1) : l;
  }));
}

function split(line: string): { indent: string; body: string } {
  const indent = line.match(/^\s*/)?.[0] ?? '';
  return { indent, body: line.slice(indent.length) };
}

function prefixFor(format: LineFormat, i: number): string {
  switch (format) {
    case 'h1': return '# ';
    case 'h2': return '## ';
    case 'h3': return '### ';
    case 'bullet': return '- ';
    case 'number': return `${i + 1}. `;
    case 'task': return '- [ ] ';
    case 'quote': return '> ';
  }
}

function hasFormat(body: string, format: LineFormat): boolean {
  switch (format) {
    case 'h1': return /^#\s/.test(body);
    case 'h2': return /^##\s/.test(body);
    case 'h3': return /^###\s/.test(body);
    case 'bullet': return /^[-*+]\s/.test(body) && !/^[-*+]\s+\[[ xX]\]\s/.test(body);
    case 'number': return /^\d+[.)]\s/.test(body);
    case 'task': return /^[-*+]\s+\[[ xX]\]\s/.test(body);
    case 'quote': return /^>\s?/.test(body);
  }
}

function stripFormat(body: string, format: LineFormat): string {
  if (format.startsWith('h')) return body.replace(HEADING, '');
  if (format === 'quote') return body.replace(/^>\s?/, '');
  return body.replace(LIST_PREFIX, '');
}

/** Headings, lists and quotes: toggled off when every non-blank selected line already has it, else applied. */
export function toggleLineFormat(text: string, start: number, end: number, format: LineFormat): TextEdit {
  return replaceLines(text, start, end, (lines) => {
    const filled = lines.filter((l) => l.trim());
    const off = filled.length > 0 && filled.every((l) => hasFormat(split(l).body, format));
    let n = 0;
    return lines.map((line) => {
      const { indent, body } = split(line);
      if (off) return indent + stripFormat(body, format);
      if (!body && lines.length > 1) return line;
      // a heading replaces another heading; a list or quote replaces another list marker
      const bare = format.startsWith('h') ? body.replace(HEADING, '') : body.replace(LIST_PREFIX, '').replace(/^>\s?/, '');
      return indent + prefixFor(format, n++) + bare;
    });
  });
}

/**
 * Enter inside a list item: start the next item (numbers count up, tasks start unchecked).
 * Enter on an empty item ends the list. Null when the caret isn't in a list item.
 */
export function continueList(text: string, start: number, end: number): TextEdit | null {
  if (start !== end) return null;
  const [from, to] = lineSpan(text, start, start);
  const match = text.slice(from, to).match(LIST_ITEM);
  if (!match) return null;
  const [, indent, marker, space, task = '', rest] = match;
  const markerEnd = from + indent.length + marker.length + space.length + task.length;
  if (start < markerEnd) return null;
  if (!rest.trim()) {
    return { text: text.slice(0, from) + text.slice(to), start: from, end: from };
  }
  const num = marker.match(/^(\d+)([.)])$/);
  const nextMarker = num ? `${Number(num[1]) + 1}${num[2]}` : marker;
  const insert = `\n${indent}${nextMarker}${space}${task ? '[ ] ' : ''}`;
  const caret = start + insert.length;
  return { text: text.slice(0, start) + insert + text.slice(start), start: caret, end: caret };
}
