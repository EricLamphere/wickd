import type * as MonacoEditor from 'monaco-editor';
import { alertDialog } from '../../../../lib/dialogs';
import { startRefactor } from '../../lib/refactorEvents';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ExtractTarget {
  uniqueId: string;
  model: string;
}

/** The CTE name to extract: the selection if it's one identifier, else the word under the cursor. */
export function cteNameAt(selected: string, wordAtCursor: string | null): string | null {
  const name = selected.trim() || wordAtCursor || '';
  return IDENTIFIER.test(name) ? name : null;
}

/**
 * "Extract CTE to model…" in the editor's context menu (SQL model files): starts
 * the extract refactor for the CTE name under the cursor. The file must be saved
 * first, since the refactor works from what's on disk.
 */
export function registerExtractCteAction(
  editor: MonacoEditor.editor.IStandaloneCodeEditor,
  target: () => ExtractTarget | null,
  isDirty: () => boolean,
): MonacoEditor.IDisposable {
  return editor.addAction({
    id: 'wickd.extract-cte',
    label: 'Extract CTE to model…',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 10,
    run: (ed) => {
      const current = target();
      if (!current) {
        void alertDialog('Only a model’s CTEs can be extracted, and this file isn’t a model in the manifest.', { title: 'Extract CTE to model' });
        return;
      }
      if (isDirty()) {
        void alertDialog('Save the file first: the refactor works from what’s on disk.', { title: 'Extract CTE to model' });
        return;
      }
      const model = ed.getModel();
      const selection = ed.getSelection();
      const position = ed.getPosition();
      const selected = model && selection ? model.getValueInRange(selection) : '';
      const word = model && position ? model.getWordAtPosition(position)?.word ?? null : null;
      const cte = cteNameAt(selected, word);
      if (!cte) {
        void alertDialog('Put the cursor on the CTE’s name (or select it), then try again.', { title: 'Extract CTE to model' });
        return;
      }
      startRefactor({ op: 'extract_cte', uniqueId: current.uniqueId, model: current.model, cte });
    },
  });
}
