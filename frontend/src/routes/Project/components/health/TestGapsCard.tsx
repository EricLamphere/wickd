import { ChevronRight } from 'lucide-react';
import { useColumnLineageData } from '../../lib/useColumnLineageData';
import { ProLabel } from '../../../../components/ProLabel';
import RunButton from './RunButton';
import Spinner from './Spinner';
import { TONE_DOT, TONE_TEXT } from './healthStatus';
import { gapSubject, testGapsCardState } from './testGapsView';
import { useTestGaps } from './useTestGaps';

const PREVIEW = 3;
const LIMIT = 50; // same query as the Test Gaps tab's default

/** Health overview card for Test Gaps (Pro): the gap count and the top few, from column lineage. */
export default function TestGapsCard({ projectId, onOpen }: { projectId: number; onOpen: () => void }) {
  const gaps = useTestGaps(projectId, LIMIT);
  // only start + progress: the snapshot itself (large) isn't fetched here
  const lineage = useColumnLineageData(projectId, false);
  const state = testGapsCardState({
    locked: gaps.locked,
    loading: gaps.loading,
    notReady: gaps.notReady,
    lineageRunning: lineage.running,
    total: gaps.data?.total ?? null,
    failed: !!gaps.error && !gaps.notReady && !gaps.locked,
  });
  const top = state.tone === 'warn' ? (gaps.data?.rows ?? []).slice(0, PREVIEW) : [];
  const progress = lineage.progress ? ` ${lineage.progress.checked} / ${lineage.progress.total} models` : '';

  return (
    <div className="flex flex-col bg-surface-panel border border-gray-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="group flex-1 flex flex-col gap-2 px-4 pt-4 pb-3 text-left hover:bg-surface-elevated/30 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${TONE_DOT[state.tone]}`} />
          <ProLabel className="flex-1 text-sm font-semibold text-gray-100">Test Gaps</ProLabel>
          <ChevronRight className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-300 transition-colors" />
        </span>
        <span className={`flex items-center gap-1.5 text-xs ${TONE_TEXT[state.tone]}`}>
          {state.tone === 'running' && <Spinner className="w-3 h-3" />}
          {state.headline}{state.tone === 'running' && progress}
        </span>
        <span className="text-[11px] text-gray-600 leading-relaxed">
          Untested join keys and grain columns, ranked by how much of the project depends on them
        </span>
        {top.length > 0 && (
          <span className="flex flex-col gap-0.5 text-[11px] text-gray-400">
            {top.map((row) => (
              <span key={row.key} className="truncate font-mono">
                {row.name}.{gapSubject(row)}
                <span className="text-gray-600"> · {row.candidates.map((c) => c.test).join(', ')}</span>
              </span>
            ))}
          </span>
        )}
        {lineage.error && <span className="text-[11px] text-red-400 break-words">{lineage.error}</span>}
      </button>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-gray-800">
        <span className="text-[10px] text-gray-600 truncate">
          From column lineage, no AI model needed
        </span>
        {state.canRefresh && <RunButton running={lineage.running} onClick={lineage.start} label="Refresh lineage" />}
      </div>
    </div>
  );
}
