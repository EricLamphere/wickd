// Editor-scoped Monaco keybindings.
//
// Never use `editor.addCommand()` for a shortcut: in standalone Monaco it registers the
// keybinding on the shared keybinding service with no editor scope and never removes it.
// After the editor unmounts its handler stays live and wins in every other editor, e.g.
// Workspace's Cmd+S ran (stale) inside Files and swallowed Files' own save.
// `addAction()` is scoped to its editor (an `editorId` precondition) and disposable.
import type * as MonacoEditor from 'monaco-editor';

type ActionEditor = Pick<MonacoEditor.editor.IStandaloneCodeEditor, 'addAction' | 'onDidDispose'>;

let lastId = 0;

/** Runs `run` when `keybinding` (e.g. `KeyMod.CtrlCmd | KeyCode.KeyS`) is pressed in this
 *  editor only; removed when the editor is disposed, or earlier via the returned disposable. */
export function bindEditorKey(
  editor: ActionEditor,
  keybinding: number,
  label: string,
  run: () => void,
): MonacoEditor.IDisposable {
  const action = editor.addAction({ id: `wickd.key.${++lastId}`, label, keybindings: [keybinding], run: () => run() });
  const onDispose = editor.onDidDispose(() => action.dispose());
  return { dispose: () => { action.dispose(); onDispose.dispose(); } };
}

/** True for Cmd+S (macOS) / Ctrl+S, whatever the Shift or Caps Lock state. */
export function isSaveShortcut(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'key'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's';
}
