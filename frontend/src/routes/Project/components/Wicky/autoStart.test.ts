import { describe, expect, it } from 'vitest';
import { autoStartFor } from './autoStart';
import type { ChatRequest } from './AiChat';

const draft: ChatRequest = { nonce: 7, text: '', mode: 'ask', action: 'semantic_draft', uniqueId: 'model.p.a' };

describe('autoStartFor', () => {
  it('starts the requested action on its node', () => {
    expect(autoStartFor(draft, null, 'model.p.a')).toEqual({ nonce: 7, action: 'semantic_draft', focusHint: undefined });
  });

  it('never starts it again once taken (clicking another node remounts QuickActions)', () => {
    expect(autoStartFor(draft, 7, 'model.p.a')).toBeNull();
    expect(autoStartFor(draft, 7, 'model.p.b')).toBeNull();
  });

  it('never starts it on a node other than the one named', () => {
    expect(autoStartFor(draft, null, 'model.p.b')).toBeNull();
  });

  it('ignores requests without an action', () => {
    expect(autoStartFor({ nonce: 1, text: 'hi', mode: 'ask' }, null, 'model.p.a')).toBeNull();
    expect(autoStartFor(null, null, 'model.p.a')).toBeNull();
  });

  it('starts an action with no node named on the current node', () => {
    expect(autoStartFor({ ...draft, uniqueId: undefined }, null, 'model.p.b')?.nonce).toBe(7);
  });
});
