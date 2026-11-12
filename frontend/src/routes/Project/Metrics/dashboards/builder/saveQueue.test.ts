import { describe, expect, it } from 'vitest';
import { createSaveQueue, type Saved } from './saveQueue';

type Doc = { n: number };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  let saved: Saved<Doc> | null = { doc: { n: 0 }, modifiedAt: 'v0' };
  let latest: Doc = { n: 0 };
  const calls: { doc: Doc; base: string | null; done: ReturnType<typeof deferred<{ modified_at: string }>> }[] = [];
  const savedEvents: [number, number][] = [];
  const states: string[] = [];
  const queue = createSaveQueue<Doc>({
    save: (doc, base) => { const done = deferred<{ modified_at: string }>(); calls.push({ doc, base, done }); return done.promise; },
    latest: () => latest,
    saved: () => saved,
    setSaved: (s) => { saved = s; },
    same: (a, b) => a.n === b.n,
    onSaved: (before, after) => savedEvents.push([before.n, after.n]),
    onState: (s) => states.push(s.kind),
  });
  return { queue, calls, savedEvents, states, edit: (n: number) => { latest = { n }; }, saved: () => saved };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('dashboard save queue', () => {
  it('sends one save at a time; a change made meanwhile goes next, on the version that save returned', async () => {
    const t = setup();
    t.edit(1);
    t.queue.flush();
    t.edit(2);
    t.queue.flush(); // the server is slow: the first save is still in flight
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ doc: { n: 1 }, base: 'v0' });

    t.calls[0].done.resolve({ modified_at: 'v1' });
    await tick();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]).toMatchObject({ doc: { n: 2 }, base: 'v1' }); // not v0: no false conflict

    t.calls[1].done.resolve({ modified_at: 'v2' });
    await tick();
    expect(t.saved()).toEqual({ doc: { n: 2 }, modifiedAt: 'v2' });
    expect(t.savedEvents).toEqual([[0, 1], [1, 2]]);
    expect(t.states.at(-1)).toBe('saved');
  });

  it('does nothing when the latest doc is already saved', () => {
    const t = setup();
    t.queue.flush();
    expect(t.calls).toHaveLength(0);
  });

  it('reports a 409 as a conflict and stops', async () => {
    const t = setup();
    t.edit(1);
    t.queue.flush();
    t.calls[0].done.reject(Object.assign(new Error('changed on disk'), { status: 409 }));
    await tick();
    expect(t.states.at(-1)).toBe('error');
    expect(t.saved()).toEqual({ doc: { n: 0 }, modifiedAt: 'v0' });
    t.edit(2);
    t.queue.flush(); // later edits still try (the user may have reloaded)
    expect(t.calls).toHaveLength(2);
  });
});
