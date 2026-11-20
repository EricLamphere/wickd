import { describe, expect, it, vi } from 'vitest';
import { bindEditorKey, isSaveShortcut } from './editorKeys';

function fakeEditor() {
  const disposeListeners: (() => void)[] = [];
  const actionDispose = vi.fn();
  const addAction = vi.fn((_: { run: () => void }) => ({ dispose: actionDispose }));
  return {
    editor: {
      addAction,
      onDidDispose: (fn: () => void) => { disposeListeners.push(fn); return { dispose: vi.fn() }; },
    },
    addAction,
    actionDispose,
    disposeEditor: () => disposeListeners.forEach((fn) => fn()),
  };
}

describe('bindEditorKey', () => {
  it('registers an editor-scoped action with the keybinding and runs the handler', () => {
    const f = fakeEditor();
    const run = vi.fn();
    bindEditorKey(f.editor as never, 2097, 'Save', run);
    const descriptor = f.addAction.mock.calls[0][0] as { keybindings: number[]; label: string; run: () => void };
    expect(descriptor.keybindings).toEqual([2097]);
    expect(descriptor.label).toBe('Save');
    descriptor.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it('removes the binding when the editor is disposed', () => {
    const f = fakeEditor();
    bindEditorKey(f.editor as never, 2097, 'Save', () => {});
    expect(f.actionDispose).not.toHaveBeenCalled();
    f.disposeEditor();
    expect(f.actionDispose).toHaveBeenCalled();
  });

  it('gives each binding its own action id', () => {
    const f = fakeEditor();
    bindEditorKey(f.editor as never, 1, 'A', () => {});
    bindEditorKey(f.editor as never, 1, 'B', () => {});
    const ids = f.addAction.mock.calls.map((c) => (c[0] as unknown as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('isSaveShortcut', () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, altKey: false, key: 's', ...o });
  it('matches Cmd/Ctrl+S, including with Shift or Caps Lock', () => {
    expect(isSaveShortcut(ev({ metaKey: true }))).toBe(true);
    expect(isSaveShortcut(ev({ ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(ev({ metaKey: true, key: 'S' }))).toBe(true);
  });
  it('ignores plain s, Alt combinations and other keys', () => {
    expect(isSaveShortcut(ev({}))).toBe(false);
    expect(isSaveShortcut(ev({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSaveShortcut(ev({ metaKey: true, key: 'a' }))).toBe(false);
  });
});
