import type * as MonacoEditor from 'monaco-editor';
import type { LineRange } from './yamlTarget';

/** How long a deep-linked block stays highlighted (the CSS fades it over the last part). */
export const FLASH_MS = 2500;
/** Taller blocks are revealed from their first line rather than centered as a whole. */
const MAX_CENTERED_LINES = 30;

/** Scrolls `range` into the middle of the editor, puts the cursor on its first line,
 *  and highlights it for FLASH_MS (`.yaml-target-flash` in styles.css). */
export function flashRange(editor: MonacoEditor.editor.IStandaloneCodeEditor, range: LineRange): void {
  const { start, end } = range;
  if (end - start < MAX_CENTERED_LINES) editor.revealLinesInCenter(start, end);
  else editor.revealLineNearTop(start);
  editor.setPosition({ lineNumber: start, column: 1 });
  const decorations = editor.createDecorationsCollection([{
    range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
    options: { isWholeLine: true, className: 'yaml-target-flash' },
  }]);
  window.setTimeout(() => decorations.clear(), FLASH_MS);
}
