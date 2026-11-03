import { loader } from '@monaco-editor/react';
import type * as MonacoEditor from 'monaco-editor';

/**
 * Marks every Monaco editor's DOM node with `nokey` so React Flow's document-level
 * key handlers leave it alone.
 *
 * Monaco 0.55 types through the EditContext API (a plain <div>, not a <textarea>)
 * where the browser supports it, so React Flow's isInputDOMNode() no longer sees an
 * input. Its pan-activation key (Space) then calls preventDefault() on every keydown
 * while any graph is mounted (the bottom pane's Execution DAG always is), and spaces
 * never reach the editor. React Flow skips any target inside `.nokey`.
 */
export function installMonacoKeyGuard(): void {
  loader
    .init()
    .then((monaco) => {
      monaco.editor.onDidCreateEditor((editor: MonacoEditor.editor.ICodeEditor) => {
        editor.getDomNode()?.classList.add('nokey');
      });
    })
    .catch((err: unknown) => {
      console.error('Monaco failed to load; editor key guard not installed', err);
    });
}
