// The dashboard editor's autosave, one save at a time. Each save sends the file version it
// starts from (`base`); the server refuses (409) when the file changed since. Two saves in
// flight at once — a slow server, a second edit — sent the same base, so the second looked like
// a conflict with the first and "Reload" threw the new widget away. Now a flush while a save is
// in flight waits for it, then sends the latest doc on the version that save returned.

export type SaveState = { kind: 'saved' } | { kind: 'pending' } | { kind: 'saving' } | { kind: 'error'; message: string; conflict: boolean };

export interface Saved<D> {
  doc: D;
  modifiedAt: string | null;
}

export interface SaveQueueOptions<D> {
  save: (doc: D, base: string | null) => Promise<{ modified_at: string | null }>;
  /** the doc being edited now */
  latest: () => D | null;
  saved: () => Saved<D> | null;
  setSaved: (saved: Saved<D>) => void;
  same: (a: D, b: D) => boolean;
  onSaved: (before: D, after: D) => void;
  onState: (state: SaveState) => void;
  message?: (err: unknown) => string;
}

const isConflict = (err: unknown) => (err as { status?: number } | null)?.status === 409;
const defaultMessage = (err: unknown) => (err instanceof Error ? err.message : 'Saving failed');

export function createSaveQueue<D>(opts: SaveQueueOptions<D>) {
  let inFlight = false;

  const flush = async (): Promise<void> => {
    if (inFlight) return; // the save in flight sends the latest doc when it's done
    const before = opts.saved();
    const doc = opts.latest();
    if (!before || !doc || opts.same(doc, before.doc)) return;
    inFlight = true;
    opts.onState({ kind: 'saving' });
    try {
      const result = await opts.save(doc, before.modifiedAt);
      opts.setSaved({ doc, modifiedAt: result.modified_at });
    } catch (err) {
      inFlight = false;
      opts.onState({ kind: 'error', conflict: isConflict(err), message: (opts.message ?? defaultMessage)(err) });
      return;
    }
    inFlight = false;
    opts.onSaved(before.doc, doc);
    const next = opts.latest();
    if (next && !opts.same(next, doc)) {
      opts.onState({ kind: 'pending' });
      await flush(); // edits made while this one was saving
    } else {
      opts.onState({ kind: 'saved' });
    }
  };

  return { flush, isSaving: () => inFlight };
}
