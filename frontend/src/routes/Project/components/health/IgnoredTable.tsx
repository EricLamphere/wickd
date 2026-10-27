import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { RichTable, type RichColumn } from '../../../../components/RichTable';
import { RowAction, TableSearch } from '../../../../components/RichTableControls';
import { pruneSelection } from '../../../../lib/richTable';
import type { IgnoredGapDto } from '../../../../lib/testGapsApi';
import { useOpenInFiles } from '../../lib/openInFiles';
import { relativeTime } from '../../lib/relativeTime';
import { DetailAction, GapDetail, GapSubject, TestPills } from './gapCells';
import { filterGaps, ignoredStatus } from './testGapsView';
import { useIgnoreGaps } from './useTestGaps';

const STATUS_TONE = {
  true: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  false: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
  null: 'bg-surface-elevated text-gray-400 border-gray-700',
} as const;

/** Rows the user ignored: unignore one from its row, or several with the checkboxes. */
export function IgnoredTable({ projectId, rows }: { projectId: number; rows: IgnoredGapDto[] }) {
  const fileNav = useOpenInFiles(projectId);
  const ignoring = useIgnoreGaps(projectId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterGaps(rows, query, new Set(), (r) => r.label), [rows, query]);

  useEffect(() => setSelected((s) => pruneSelection(s, rows.map((r) => r.key))), [rows]);

  const columns = useMemo<RichColumn<IgnoredGapDto>[]>(() => [
    {
      id: 'column', header: 'Column', sortValue: (r) => `${r.name}.${r.label}`, width: 'w-[28%]',
      cell: (r) => <GapSubject uniqueId={r.unique_id} model={r.name} label={r.label} fileNav={fileNav} />,
    },
    { id: 'tests', header: 'Would suggest', cell: (r) => <TestPills candidates={r.candidates} /> },
    {
      id: 'status', header: 'Status', width: 'w-56', sortValue: (r) => (r.still_a_gap === null ? 2 : r.still_a_gap ? 0 : 1),
      cell: (r) => (
        <span className={`inline-flex px-1.5 py-0.5 rounded border text-[11px] ${STATUS_TONE[String(r.still_a_gap) as keyof typeof STATUS_TONE]}`}>
          {ignoredStatus(r)}
        </span>
      ),
    },
    {
      id: 'ignored', header: 'Ignored', align: 'right', width: 'w-24', defaultDir: 'desc', sortValue: (r) => r.ignored_at,
      cell: (r) => <span className="text-gray-400" title={new Date(r.ignored_at).toLocaleString()}>{relativeTime(r.ignored_at)}</span>,
    },
  ], [fileNav]);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-surface-panel px-4 py-10 text-center text-xs text-gray-500">
        Nothing ignored. Use a row’s <EyeOff size={11} className="inline align-[-1px]" /> button under Gaps to hide a gap you don’t want tests for.
      </div>
    );
  }

  const keys = [...selected];
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <TableSearch value={query} onChange={setQuery} placeholder="Filter by model or column…" />
        <span className="flex-1" />
        <span className="text-[11px] text-gray-500">Hidden from Gaps, even as the ranking changes, until unignored</span>
      </div>
      {keys.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-brand-900/60 bg-brand-950/30 text-xs">
          <span className="text-brand-200">{keys.length} selected</span>
          <button type="button" onClick={() => setSelected(new Set())} className="text-gray-400 hover:text-gray-200">Clear</button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => ignoring.unignore(keys)}
            disabled={ignoring.busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-700 bg-surface-elevated text-gray-200 hover:bg-gray-700 disabled:opacity-50"
          >
            {ignoring.busy ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
            Unignore ({keys.length})
          </button>
        </div>
      )}
      {ignoring.error && <p className="text-xs text-red-400">{ignoring.error}</p>}
      <RichTable
        ariaLabel="Ignored test gaps"
        rows={shown}
        columns={columns}
        rowKey={(r) => r.key}
        initialSort={{ id: 'ignored', dir: 'desc' }}
        selection={{ selected, onChange: setSelected }}
        actionsWidth="w-12"
        rowActions={(r) => <RowAction icon={<Eye size={13} />} label="Unignore" onClick={() => ignoring.unignore([r.key])} />}
        renderExpanded={(r) => (
          <GapDetail
            projectId={projectId}
            uniqueId={r.unique_id}
            model={r.name}
            candidates={r.candidates}
            fileNav={fileNav}
            actions={(
              <DetailAction icon={<Eye size={12} />} label="Unignore" disabled={ignoring.busy} onClick={() => ignoring.unignore([r.key])} />
            )}
          />
        )}
        empty="No ignored gaps match the filter."
      />
    </div>
  );
}
