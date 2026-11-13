import { loader } from '@monaco-editor/react';
import type * as MonacoEditor from 'monaco-editor';

const GUARD_CLASS = 'nokey';

/**
 * Marks every Monaco editor's container with `nokey` so React Flow's document-level
 * key handlers leave it alone.
 *
 * Monaco 0.55 types through the EditContext API (a plain <div>, not a <textarea>)
 * where the browser supports it, so React Flow's isInputDOMNode() no longer sees an
 * input. Its pan-activation key (Space) then calls preventDefault() on every keydown
 * while any graph is mounted (the bottom pane's Node DAG / Execution DAG), and spaces
 * never reach the editor; Backspace (its delete key) too while nodes are selected.
 * React Flow skips any target inside `.nokey`.
 *
 * The class goes on the container (getContainerDomNode()), never on the `.monaco-editor`
 * node: Monaco rewrites that node's whole className when the theme or options apply,
 * which silently wiped the class. A MutationObserver puts it back if anything (React
 * re-rendering the container's className) removes it.
 */
export function installMonacoKeyGuard(): void {
  loader
    .init()
    .then((monaco) => {
      monaco.editor.onDidCreateEditor((editor: MonacoEditor.editor.ICodeEditor) => {
        const stop = guard(editor.getContainerDomNode());
        editor.onDidDispose(stop);
      });
    })
    .catch((err: unknown) => {
      console.error('Monaco failed to load; editor key guard not installed', err);
    });
}

/** Keep `nokey` on `el`; returns a function that stops watching it. */
function guard(el: HTMLElement | null | undefined): () => void {
  if (!el) return () => undefined;
  const ensure = () => {
    if (!el.classList.contains(GUARD_CLASS)) el.classList.add(GUARD_CLASS);
  };
  ensure();
  const observer = new MutationObserver(ensure);
  observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
