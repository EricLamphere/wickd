import type * as MonacoEditor from 'monaco-editor';
import { alertDialog } from '../../../../lib/dialogs';
import { addMetricNote } from '../../Metrics/notes/noteEvents';
import { metricAtLine } from '../../Metrics/notes/lib/yamlMetric';

/**
 * "Add metric note…" in the editor's context menu (YAML files, plan 30): a New note for the
 * metric whose definition holds the cursor (Metrics/notes/lib/yamlMetric.ts).
 */
export function registerMetricNoteAction(editor: MonacoEditor.editor.IStandaloneCodeEditor): MonacoEditor.IDisposable {
  return editor.addAction({
    id: 'wickd.add-metric-note',
    label: 'Add metric note…',
    contextMenuGroupId: '9_cutcopypaste',
    contextMenuOrder: 20,
    run: (ed) => {
      const model = ed.getModel();
      const line = ed.getPosition()?.lineNumber ?? 1;
      const metric = model ? metricAtLine(model.getValue(), line) : null;
      if (!metric) {
        void alertDialog('Put the cursor inside a metric’s definition (under `metrics:`), then try again.', { title: 'Add metric note' });
        return;
      }
      addMetricNote({ kind: 'metric', metric });
    },
  });
}
