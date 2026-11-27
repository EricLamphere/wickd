// Failed Rows for several failed tests selected in the DAG: a dropdown of their names switches
// which test's rows FailedRowsPanel shows.
import { useState } from 'react';
import type { ModelNode } from '../../../../lib/api';
import { FailedRowsPanel, type FailedRowsCache } from './FailedRowsPanel';
import { pickFailedTest } from './failedTests';

interface MultiFailedRowsProps {
  projectId: number;
  tests: readonly ModelNode[];
  failedRowsCache?: FailedRowsCache;
  onFailedRowsCached?: (uid: string, data: { columns: string[]; rows: unknown[][] }) => void;
}

export function MultiFailedRows({ projectId, tests, failedRowsCache, onFailedRowsCached }: MultiFailedRowsProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const current = pickFailedTest(tests, picked);
  if (current === null) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 shrink-0">
        <span className="text-xs text-gray-500 shrink-0">{tests.length} failed tests</span>
        <select
          value={current}
          onChange={(e) => setPicked(e.target.value)}
          aria-label="Failed test"
          className="flex-1 min-w-0 form-select border rounded px-2 py-1 text-xs"
        >
          {tests.map((t) => <option key={t.unique_id} value={t.unique_id}>{t.name}</option>)}
        </select>
      </div>
      <div className="flex-1 min-h-0">
        <FailedRowsPanel
          key={current}
          projectId={projectId}
          model={{ unique_id: current }}
          failedRowsCache={failedRowsCache}
          onFailedRowsCached={onFailedRowsCached}
        />
      </div>
    </div>
  );
}
