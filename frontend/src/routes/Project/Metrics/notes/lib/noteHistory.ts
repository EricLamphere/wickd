// The note dialog's back / forward history (plan 33): following a link to another note pushes it;
// back and forward step through. Pure; tested in noteHistory.test.ts.
export interface NoteHistory {
  stack: readonly string[];
  index: number;
}

export const startHistory = (slug: string): NoteHistory => ({ stack: [slug], index: 0 });

export const currentNote = (h: NoteHistory): string => h.stack[h.index];

/** Open `slug` after the current note (anything ahead of it is dropped, like a browser). */
export function pushNote(h: NoteHistory, slug: string): NoteHistory {
  if (currentNote(h) === slug) return h;
  const stack = [...h.stack.slice(0, h.index + 1), slug];
  return { stack, index: stack.length - 1 };
}

export const canGoBack = (h: NoteHistory): boolean => h.index > 0;
export const canGoForward = (h: NoteHistory): boolean => h.index < h.stack.length - 1;
export const goBack = (h: NoteHistory): NoteHistory => (canGoBack(h) ? { ...h, index: h.index - 1 } : h);
export const goForward = (h: NoteHistory): NoteHistory => (canGoForward(h) ? { ...h, index: h.index + 1 } : h);

/** The history without a note that no longer exists (deleted), staying on a neighbour. */
export function dropNote(h: NoteHistory, slug: string): NoteHistory | null {
  // without it, and without the repeats that leaves side by side (a → b → a becomes a)
  const stack = h.stack.filter((s) => s !== slug).filter((s, i, all) => i === 0 || s !== all[i - 1]);
  if (!stack.length) return null;
  const before = h.stack.slice(0, h.index + 1).filter((s) => s !== slug).length;
  return { stack, index: Math.min(Math.max(before - 1, 0), stack.length - 1) };
}
