import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { useUrlTab } from '../../../../lib/useUrlTab';
import { useColumnLineageData } from '../../lib/useColumnLineageData';
import { UpgradeModal } from '../UpgradeModal';
import { LineageNotReadyNotice } from '../propagation/LineageNotReadyNotice';
import { usePropagateProposal } from '../propagation/usePropagation';
import { GapsTable, LIMITS } from './GapsTable';
import { IgnoredTable } from './IgnoredTable';
import { useIgnoredGaps, useTestGaps } from './useTestGaps';

const FEATURE = 'Smarter test suggestions';
const OUTDATED = 'Column lineage needs a refresh: the last scan doesn’t record join keys and grain.';

type GapsView = 'gaps' | 'ignored';
const VIEWS: readonly GapsView[] = ['gaps', 'ignored'];

/** Health → Test gaps (Pro): untested columns ranked by how much depends on them, with lineage-backed tests. */
export default function TestGapsPanel({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const [limit, setLimit] = useState(LIMITS[0]);
  const [view, setView] = useUrlTab<GapsView>('gaps', VIEWS, 'gaps');
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const gaps = useTestGaps(projectId, limit);
  const ignored = useIgnoredGaps(projectId, !gaps.locked);
  // start + progress only: the (large) snapshot isn't fetched here
  const lineage = useColumnLineageData(projectId, false);
  const proposal = usePropagateProposal(projectId);

  if (gaps.locked || proposal.locked) {
    return (
      <>
        <LockedState onUnlock={() => setUpgradeOpen(true)} />
        {(upgradeOpen || proposal.locked) && (
          <UpgradeModal feature={FEATURE} onClose={() => { setUpgradeOpen(false); proposal.clearLocked(); }} />
        )}
      </>
    );
  }

  // re-trace lineage (a no-op when the manifest hasn't changed), then re-rank against the current manifest
  const refresh = async () => {
    await lineage.start();
    qc.invalidateQueries({ queryKey: ['test-gaps', projectId] });
  };
  const refreshing = lineage.running || gaps.notReady === 'running';
  const progress = lineage.compiling
    ? ' (compiling…)'
    : lineage.progress ? ` (${lineage.progress.checked} / ${lineage.progress.total} models)` : '';
  const ignoredRows = ignored.data?.rows ?? [];
  const counts: Record<GapsView, number | null> = {
    gaps: gaps.data?.total ?? null,
    ignored: ignored.data ? ignoredRows.length : null,
  };

  return (
    <div className="p-6 pb-12 max-w-[80rem] mx-auto w-full space-y-4">
      <div className="flex items-start gap-4">
        <div className="flex-1 space-y-1">
          <h2 className="text-sm font-semibold text-gray-200">Test gaps</h2>
          <p className="max-w-3xl text-xs text-gray-500">
            Columns that other models join on, and the columns each model is unique on (its GROUP BY,
            DISTINCT or deduplication), ranked by how much of the project depends on them. Suggestions come
            from column lineage, so they don’t need the AI model. Each test is checked against the warehouse
            before you review it.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          title="Re-trace column lineage and re-rank. Picks up changed joins and grain, and tests added since."
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 bg-surface-elevated text-gray-300 hover:bg-gray-700 disabled:opacity-60 shrink-0"
        >
          {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {refreshing ? `Refreshing${progress}` : 'Refresh'}
        </button>
      </div>
      {lineage.error && <p className="text-xs text-red-400">{lineage.error}</p>}

      <div className="flex gap-1 border-b border-gray-800">
        {VIEWS.map((id) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors ${
              view === id ? 'text-brand-300 border-brand-500 font-medium' : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            {id === 'gaps' ? 'Gaps' : 'Ignored'}
            {counts[id] !== null && <span className="ml-1.5 text-gray-500">{counts[id]}</span>}
          </button>
        ))}
      </div>

      {view === 'ignored' ? (
        ignored.isLoading ? (
          <p className="text-xs text-gray-500">Loading…</p>
        ) : ignored.error ? (
          <p className="text-xs text-red-400">{ignored.error instanceof Error ? ignored.error.message : String(ignored.error)}</p>
        ) : (
          <IgnoredTable projectId={projectId} rows={ignoredRows} />
        )
      ) : gaps.notReady ? (
        <LineageNotReadyNotice projectId={projectId} reason={gaps.notReady} outdated={OUTDATED} />
      ) : gaps.loading ? (
        <p className="text-xs text-gray-500">Ranking columns…</p>
      ) : gaps.error ? (
        <p className="text-xs text-red-400">{gaps.error instanceof Error ? gaps.error.message : String(gaps.error)}</p>
      ) : gaps.data ? (
        <GapsTable projectId={projectId} data={gaps.data} limit={limit} onLimit={setLimit} proposal={proposal} />
      ) : null}
    </div>
  );
}

function LockedState({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <FlaskConical size={28} className="text-gray-600" />
      <h2 className="text-sm font-semibold text-gray-200">Test the columns that matter</h2>
      <p className="max-w-md text-xs text-gray-500">
        wickd Pro finds the columns your models join on and the grain each model is unique on, ranks the
        untested ones by how much of the project depends on them, and proposes not_null, unique and
        relationships tests with the evidence for each.
      </p>
      <ProFeatureButton onClick={onUnlock}>Unlock test gaps</ProFeatureButton>
    </div>
  );
}
