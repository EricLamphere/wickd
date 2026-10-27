import { useCallback, useEffect, useMemo, useState } from 'react';
import { EyeOff, FlaskConical, Loader2 } from 'lucide-react';
import { RichTable, type RichColumn } from '../../../../components/RichTable';
import { RowAction, TableSearch } from '../../../../components/RichTableControls';
import { FilterDropdown } from '../FilterDropdown';
import { MeterBar } from '../../../../components/charts/MeterBar';
import { pruneSelection } from '../../../../lib/richTable';
import { useProjectEvents } from '../../../../lib/sse';
import { testGapsApi, type TestGapDto, type TestGapsDto } from '../../../../lib/testGapsApi';
import { useOpenInFiles } from '../../lib/openInFiles';
import { ProposalReviewModal } from '../Wicky/ProposalReviewModal';
import type { usePropagateProposal } from '../propagation/usePropagation';
import { DetailAction, GapDetail, GapSubject, GapUse, TestPills } from './gapCells';
import { TEST_LABEL, filterGaps, gapSubject, testCounts } from './testGapsView';
import { useIgnoreGaps } from './useTestGaps';

export const LIMITS = [50, 100, 200, 500];

interface GapsTableProps {
  projectId: number;
  data: TestGapsDto;
  limit: number;
  onLimit: (limit: number) => void;
  proposal: ReturnType<typeof usePropagateProposal>;
}

/** The ranked gaps: filter, tick rows (or use a row's own buttons), then generate tests or ignore. */
export function GapsTable({ projectId, data, limit, onLimit, proposal }: GapsTableProps) {
  const fileNav = useOpenInFiles(projectId);
  const ignoring = useIgnoreGaps(projectId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [tests, setTests] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);

  const rows = useMemo(() => filterGaps(data.rows, query, tests, gapSubject), [data.rows, query, tests]);
  const maxScore = Math.max(...data.rows.map((r) => r.score), 1);

  // keep the selection across refetches, minus rows that are gone (tested, ignored)
  useEffect(() => setSelected((s) => pruneSelection(s, data.rows.map((r) => r.key))), [data.rows]);

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type !== 'ai_proposal_progress') return;
    const d = event.data as { unique_id: string | null; done?: number; total?: number; current?: string };
    if (d.unique_id === null && typeof d.done === 'number' && typeof d.total === 'number') {
      setProgress({ done: d.done, total: d.total, current: d.current ?? '' });
    }
  }, []));
  useEffect(() => {
    if (!proposal.building) setProgress(null);
  }, [proposal.building]);

  const generate = (keys: string[]) => proposal.start(() => testGapsApi.generate(projectId, keys));
  const keys = [...selected];
  const count = keys.length > 0 ? ` (${keys.length})` : '';

  const columns = useMemo<RichColumn<TestGapDto>[]>(() => [
    {
      id: 'column', header: 'Column', sortValue: (r) => `${r.name}.${gapSubject(r)}`, width: 'w-[24%]',
      cell: (r) => <GapSubject uniqueId={r.unique_id} model={r.name} label={gapSubject(r)} fileNav={fileNav} />,
    },
    { id: 'tests', header: 'Suggested tests', width: 'w-[22%]', cell: (r) => <TestPills candidates={r.candidates} /> },
    {
      id: 'why', header: 'Why',
      cell: (r) => (
        <span className="line-clamp-2 text-[11.5px] text-gray-400" title={r.candidates.map((c) => c.evidence).join('\n')}>
          {r.candidates[0]?.evidence}
          {r.candidates.length > 1 && <span className="text-gray-600"> · +{r.candidates.length - 1} more</span>}
        </span>
      ),
    },
    { id: 'use', header: 'Used by', width: 'w-32', cell: (r) => <GapUse row={r} />, sortValue: (r) => r.reach + r.row_uses * 3 + r.exposures * 5, defaultDir: 'desc' },
    {
      id: 'score', header: 'Risk', align: 'right', width: 'w-28', defaultDir: 'desc', sortValue: (r) => r.score,
      headerTitle: 'How much depends on this column: downstream columns, models filtering/joining on it (×3), exposures (×5), doubled for grain',
      cell: (r) => (
        <span className="inline-flex items-center gap-2 justify-end">
          <MeterBar value={r.score} max={maxScore} className="w-14" tone="bg-amber-500" />
          <span className="w-7 text-right tabular-nums text-gray-300">{r.score}</span>
        </span>
      ),
    },
  ], [fileNav, maxScore]);

  if (data.rows.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-surface-panel px-4 py-10 text-center text-xs text-gray-500">
        No gaps found: every join key and grain column lineage can see is already tested
        {data.ignored > 0 ? ' or ignored' : ''}.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <TableSearch value={query} onChange={setQuery} placeholder="Filter by model or column…" />
        <FilterDropdown
          label="Test"
          options={testCounts(data.rows).map(([id]) => id)}
          optionLabel={(id) => TEST_LABEL[id] ?? id}
          selected={tests}
          onChange={setTests}
        />
        <span className="flex-1" />
        <span className="text-[11px] text-gray-500">
          {data.total > data.rows.length ? `Top ${data.rows.length} of ${data.total}` : `${data.total} gaps`}
        </span>
        <select
          value={limit}
          onChange={(e) => onLimit(Number(e.target.value))}
          className="form-select border rounded px-2 py-1 text-xs"
          aria-label="How many to show"
        >
          {LIMITS.map((n) => <option key={n} value={n}>Show {n}</option>)}
        </select>
      </div>

      {keys.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-brand-900/60 bg-brand-950/30 text-xs">
          <span className="text-brand-200">{keys.length} selected</span>
          <button type="button" onClick={() => setSelected(new Set())} className="text-gray-400 hover:text-gray-200">Clear</button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => ignoring.ignore(keys)}
            disabled={ignoring.busy || proposal.building}
            title="Hide these from Test gaps. They move to Ignored, where you can unignore them."
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-700 bg-surface-elevated text-gray-300 hover:bg-gray-700 disabled:opacity-50"
          >
            {ignoring.busy ? <Loader2 size={12} className="animate-spin" /> : <EyeOff size={12} />}
            Ignore{count}
          </button>
          <button
            type="button"
            onClick={() => generate(keys)}
            disabled={proposal.building}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
          >
            {proposal.building ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
            Generate tests{count}
          </button>
        </div>
      )}
      {proposal.building && (
        <p className="flex items-center gap-2 text-xs text-gray-400">
          <Loader2 size={12} className="animate-spin text-brand-400" />
          Checking the tests against the warehouse
          {progress ? `: ${progress.current} (${progress.done + 1} of ${progress.total})` : '…'}
        </p>
      )}
      {proposal.notice && <p className="text-xs text-gray-500">{proposal.notice}</p>}
      {ignoring.error && <p className="text-xs text-red-400">{ignoring.error}</p>}

      <RichTable
        ariaLabel="Test gaps"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.key}
        initialSort={{ id: 'score', dir: 'desc' }}
        selection={{ selected, onChange: setSelected }}
        rowActions={(r) => (
          <>
            <RowAction icon={<EyeOff size={13} />} label="Ignore" onClick={() => ignoring.ignore([r.key])} />
            <RowAction icon={<FlaskConical size={13} />} label="Generate these tests" tone="brand" onClick={() => generate([r.key])} />
          </>
        )}
        renderExpanded={(r) => (
          <GapDetail
            projectId={projectId}
            uniqueId={r.unique_id}
            model={r.name}
            candidates={r.candidates}
            fileNav={fileNav}
            actions={(
              <>
                <DetailAction icon={<EyeOff size={12} />} label="Ignore" disabled={ignoring.busy} onClick={() => ignoring.ignore([r.key])} />
                <DetailAction
                  icon={<FlaskConical size={12} />}
                  label="Generate these tests"
                  brand
                  disabled={proposal.building}
                  onClick={() => generate([r.key])}
                />
              </>
            )}
          />
        )}
        empty="No gaps match the filter."
      />
      <p className="text-[11px] text-gray-600">
        Click a row for the evidence · ⌘-click a model name to open it · Shift-click checkboxes to select a range · ↑↓ Space Enter work too
      </p>

      {proposal.reviewing && (
        <ProposalReviewModal projectId={projectId} proposal={proposal.reviewing} onClose={proposal.closeReview} />
      )}
    </div>
  );
}
