// Mentions in a note's body (plan 33), one syntax for all three: `note:other-note`,
// `model:fct_orders`, `commit:3f2a9c1`. Older `[[other-note]]` links still render.
// - tokenAt(): the mention being typed at the caret, for the editor's suggestions;
// - applyCompletion(): the text with the chosen suggestion written in;
// - linkifyMentions(): the body with mentions as links showing only the name (the note's title,
//   the node's name, the short hash), on custom schemes NoteMarkdown handles;
// - backlinks(): notes that link to a note.
// The backend reads the same syntax (app/semantic/notes.py mentions()). Pure; tested in
// noteMentions.test.ts. No regex lookbehind (older WebKit lacks it).

export type MentionKind = 'note' | 'model' | 'commit';

export interface MentionToken {
  kind: MentionKind;
  /** what's typed after `note:`, `model:` or `commit:` */
  query: string;
  /** where the mention starts (the `n` of `note:`, …) and the caret */
  from: number;
  to: number;
}

const WORD_BREAK = /[\s([,;]/;
const PREFIX: Record<MentionKind, string> = { note: 'note:', model: 'model:', commit: 'commit:' };

/** The mention being typed just before `caret`, or null. */
export function tokenAt(text: string, caret: number): MentionToken | null {
  const before = text.slice(0, caret);
  let start = caret;
  while (start > 0 && !WORD_BREAK.test(before[start - 1])) start -= 1;
  const word = before.slice(start);
  for (const kind of ['note', 'model', 'commit'] as const) {
    if (word.toLowerCase().startsWith(PREFIX[kind])) {
      return { kind, query: word.slice(PREFIX[kind].length), from: start, to: caret };
    }
  }
  return null;
}

/** `text` with the token replaced by the completed mention, and where the caret goes. */
export function applyCompletion(text: string, token: MentionToken, value: string): { text: string; caret: number } {
  const insert = `${PREFIX[token.kind]}${value}`;
  const next = text.slice(0, token.from) + insert + text.slice(token.to);
  return { text: next, caret: token.from + insert.length };
}

/** Items whose key starts with the query first, then those containing it; at most `limit`. */
export function rankByQuery<T>(items: readonly T[], query: string, keys: (item: T) => string[], limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const ks = keys(item).map((k) => k.toLowerCase());
    if (ks.some((k) => k.startsWith(q))) prefix.push(item);
    else if (ks.some((k) => k.includes(q))) contains.push(item);
  }
  return [...prefix, ...contains].slice(0, limit);
}

// ── rendering ────────────────────────────────────────────────────────────────

export const MENTION_SCHEME: Record<MentionKind, string> = { note: 'wickd-note:', model: 'wickd-model:', commit: 'wickd-commit:' };

/** the older note link, still rendered */
const NOTE_LINK = /\[\[([a-z0-9][a-z0-9_-]{0,79})(?:\|([^\]\n]*))?\]\]/g;
const NOTE = /(^|[\s([,;])note:([a-z0-9][a-z0-9_-]{0,79})/g;
const MODEL = /(^|[\s([,;])model:([A-Za-z0-9_][A-Za-z0-9_.]*[A-Za-z0-9_])/g;
const COMMIT = /(^|[\s([,;])commit:([0-9a-fA-F]{7,40})\b/g;

/** Link text: Markdown's brackets and backslashes taken out so a title can't break the link. */
const linkText = (s: string) => s.replace(/[[\]\\]/g, '');

function linkifyText(text: string, title: (slug: string) => string | null): string {
  const noteLink = (slug: string, alias?: string) => `[${linkText(alias?.trim() || title(slug) || slug)}](${MENTION_SCHEME.note}${slug})`;
  return text
    .replace(NOTE_LINK, (_m, slug: string, alias?: string) => noteLink(slug, alias))
    .replace(NOTE, (_m, pre: string, slug: string) => `${pre}${noteLink(slug.replace(/-+$/, ''))}`)
    .replace(MODEL, (_m, pre: string, name: string) => `${pre}[${name}](${MENTION_SCHEME.model}${name})`)
    .replace(COMMIT, (_m, pre: string, sha: string) => `${pre}[${sha.slice(0, 7).toLowerCase()}](${MENTION_SCHEME.commit}${sha.toLowerCase()})`);
}

/** Split into code (fenced blocks, inline spans: left alone) and prose. */
function segments(body: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /(^(```|~~~)[^\n]*\n[\s\S]*?^\2[ \t]*$)|(`[^`\n]*`)/gm;
  let last = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > last) out.push({ code: false, text: body.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ code: false, text: body.slice(last) });
  return out;
}

/** The body with mentions as Markdown links to `wickd-note:` / `wickd-model:` / `wickd-commit:`,
 *  each showing only the name: the note's title (else its slug), the node's name, the short hash. */
export function linkifyMentions(body: string, title: (slug: string) => string | null = () => null): string {
  return segments(body).map((s) => (s.code ? s.text : linkifyText(s.text, title))).join('');
}

/** A rendered link's mention, or null for an ordinary link. */
export function parseMentionHref(href: string | undefined | null): { kind: MentionKind; value: string } | null {
  if (!href) return null;
  for (const kind of ['note', 'model', 'commit'] as const) {
    if (href.startsWith(MENTION_SCHEME[kind])) return { kind, value: href.slice(MENTION_SCHEME[kind].length) };
  }
  return null;
}

/** Notes whose body links to `slug`. */
export function backlinks<T extends { slug: string; links?: string[] }>(notes: readonly T[], slug: string): T[] {
  return notes.filter((n) => n.slug !== slug && (n.links ?? []).includes(slug));
}

/** Notes that mention a dbt node by name (`model:<name>`). */
export function notesMentioning<T extends { models?: string[] }>(notes: readonly T[], name: string): T[] {
  const n = name.toLowerCase();
  return notes.filter((note) => (note.models ?? []).some((m) => m.toLowerCase() === n || m.toLowerCase().endsWith(`.${n}`)));
}
