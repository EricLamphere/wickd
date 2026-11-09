import type * as MonacoEditor from 'monaco-editor';
import { alertDialog } from '../../../../lib/dialogs';
import { startUnitTest } from '../../components/SidePane/UnitTestsSection';

export interface UnitTestTarget {
  uniqueId: string;
}

/**
 * "Unit test this logic…" in a SQL model's context menu (wickd Pro): opens Wicky's
 * unit test options with the focus preselected from the selection or cursor (a CASE
 * column it aliases, a CTE it defines, else the CTE it sits in). Pro gating happens in Wicky.
 */
export function registerUnitTestAction(
  editor: MonacoEditor.editor.IStandaloneCodeEditor,
  target: () => UnitTestTarget | null,
): MonacoEditor.IDisposable {
  return editor.addAction({
    id: 'wickd.unit-test-logic',
    label: 'Unit test this logic…',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 11,
    run: (ed) => {
      const current = target();
      if (!current) {
        void alertDialog('Only models can be unit tested, and this file isn’t a model in the manifest.', { title: 'Unit test this logic' });
        return;
      }
      const model = ed.getModel();
      const selection = ed.getSelection();
      if (!model || !selection) {
        startUnitTest(current.uniqueId);
        return;
      }
      // the text before the selection lets Wicky find the CTE the selection sits in
      const before = model.getValueInRange({
        startLineNumber: 1, startColumn: 1,
        endLineNumber: selection.startLineNumber, endColumn: selection.startColumn,
      });
      startUnitTest(current.uniqueId, { selection: model.getValueInRange(selection), before });
    },
  });
}
