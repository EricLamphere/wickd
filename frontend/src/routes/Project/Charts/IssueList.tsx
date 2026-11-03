// A board's problems from `dct validate` and its last build: collapsed to a count, expandable.
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import type { ChartsDiagnostic } from '../../../lib/chartsApi';
import { issueCounts } from './chartsView';

export function IssueList({ issues, onOpenLine }: { issues: ChartsDiagnostic[]; onOpenLine: () => void }) {
  const counts = issueCounts(issues);
  const [open, setOpen] = useState(counts.errors > 0);
  if (issues.length === 0) return null;
  const summary = [counts.errors && `${counts.errors} error${counts.errors === 1 ? '' : 's'}`,
    counts.warnings && `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  return (
    <div className="border-b border-gray-800">
      <button onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 w-full px-4 py-1.5 text-xs ${counts.errors ? 'text-red-300' : 'text-amber-300'} hover:bg-surface-elevated`}>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {summary}
      </button>
      {open && (
        <ul className="flex flex-col gap-2 max-h-48 overflow-y-auto px-4 pb-3">
          {issues.map((d, i) => (
            <li key={`${d.code}-${i}`} className="flex gap-2 text-xs">
              {d.level === 'error'
                ? <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-400" />
                : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-400" />}
              <div className="min-w-0">
                <p className="text-gray-200">
                  {d.message}
                  {(d.chart || d.query) && <span className="text-gray-500"> · {d.chart ? `chart ${d.chart}` : `query ${d.query}`}</span>}
                  {d.line != null && (
                    <button onClick={onOpenLine} className="ml-1 text-brand-400 hover:underline">line {d.line}</button>
                  )}
                </p>
                {d.hint && <p className="mt-0.5 text-gray-500">{d.hint}</p>}
                <p className="mt-0.5 font-mono text-[10px] text-gray-600">{d.code}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
