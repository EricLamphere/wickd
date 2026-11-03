// Debug tab: MetricFlow's whole SQL for the query, with the selected plan step's part
// highlighted: its SELECT and the comments above it faintly (minus other steps' SELECTs nested in
// it), the lines doing the step's work strongly (lib/planSqlCode.ts), else the comment naming it and scrolled into view. Where the step is:
// lib/planGraph.ts sqlSpanFor().
import { useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { ExternalLink } from 'lucide-react';
import { useTheme } from '../../../../../lib/useTheme';
import type { SqlSpan } from '../../lib/planGraph';

type CodeEditor = Parameters<OnMount>[0];

export function PlanSqlView({ sql, span, stepName, onOpenInWorkspace }: {
  sql: string; span: SqlSpan | null; stepName: string | null; onOpenInWorkspace: (sql: string) => void;
}) {
  const theme = useTheme();
  const editor = useRef<CodeEditor | null>(null);
  const decorations = useRef<ReturnType<CodeEditor['createDecorationsCollection']> | null>(null);

  const highlight = () => {
    const ed = editor.current;
    if (!ed) return;
    decorations.current?.clear();
    if (!span) return;
    const whole = (start: number, end: number, className: string) => ({
      range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
      options: { isWholeLine: true, className },
    });
    // strong: the lines doing the step's work; when none can be told apart, the comment naming it
    const strong = span.code.length ? span.code : span.focus ? [span.focus] : [];
    decorations.current = ed.createDecorationsCollection([
      ...span.ranges.map(([a, b]) => whole(a, b, 'plan-sql-step')),
      ...strong.map((n) => whole(n, n, 'plan-sql-focus')),
    ]);
    if (strong.length) ed.revealLinesInCenterIfOutsideViewport(strong[0], strong[strong.length - 1]);
    else ed.revealLinesInCenterIfOutsideViewport(span.start, Math.min(span.end, span.start + 20));
  };

  useEffect(highlight, [span?.start, span?.end, span?.focus, JSON.stringify(span?.ranges), JSON.stringify(span?.code)]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-gray-300">MetricFlow’s SQL</span>
        {stepName && (
          <span className="text-[11px] text-gray-500 truncate">
            {!span ? `${stepName} isn’t a separate part of this SQL`
              : span.code.length || span.focus ? <>highlighted: <span className="text-brand-300">{stepName}</span></>
              : `${stepName} isn’t used by this query’s SQL`}
          </span>
        )}
        <button onClick={() => onOpenInWorkspace(sql)} className="flex items-center gap-1 ml-auto text-[11px] text-gray-400 hover:text-gray-200">
          <ExternalLink className="w-3 h-3" />Open in Workspace
        </button>
      </div>
      <div className="rounded border border-gray-800 overflow-hidden h-80">
        <Editor language="sql" value={sql} theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
          onMount={(ed) => { editor.current = ed; highlight(); }}
          options={{ readOnly: true, domReadOnly: true, fontSize: 11, minimap: { enabled: false }, scrollBeyondLastLine: false,
            automaticLayout: true, lineNumbers: 'on', folding: false, padding: { top: 6 } }} />
      </div>
    </div>
  );
}
