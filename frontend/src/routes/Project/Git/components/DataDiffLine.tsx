import { useMemo } from 'react';
import { Database, Loader2, Play } from 'lucide-react';
import { diffRequest, diffSummaryText, isDiffable, phaseLabel, readBuildPreference, readKeys, summarizeDiffs } from '../../lib/dataDiff';
import { useDataDiff } from '../../lib/useDataDiff';
import { dismissBuildNudge, useBuildNudge } from '../../lib/buildNudge';
import { openBottomTab } from '../../lib/bottomPaneEvents';
import { relativeTime } from '../../lib/relativeTime';
import type { ModelNode } from '../../../../lib/api';
import { useSlimSettings } from '../../components/slim/useSlimSettings';
import { DiffResultChips } from '../../components/dataDiff/diffUi';

const CHIP_LIMIT = 3;

/**
 * The uncommitted changes' data diff (Pro) on the Git page: the latest result, or a button to
 * diff the changed models before committing. Hidden without Pro or DIFF_BASE_TARGET.
 */
export function DataDiffLine({ projectId, changed }: { projectId: number; changed: readonly ModelNode[] }) {
  const state = useDataDiff(projectId, true);
  const { baseTarget } = useSlimSettings(projectId);
  const nudge = useBuildNudge(projectId);
  const diffable = useMemo(() => changed.filter(isDiffable).map((n) => n.unique_id), [changed]);
  const summary = useMemo(() => summarizeDiffs(state.byModel, diffable), [state.byModel, diffable]);

  if (state.locked || !baseTarget || diffable.length === 0) return null;

  const showImpact = () => openBottomTab('impact', { impactMode: 'working', dataDiff: true });
  const start = (build: boolean) => {
    dismissBuildNudge(projectId);
    void state.start(diffRequest(readKeys(projectId), diffable, build, 'working', null));
  };

  if (state.running) {
    return (
      <button onClick={showImpact} className="flex items-center gap-1.5 text-left text-[11px] text-brand-300 hover:underline">
        <Loader2 size={12} className="animate-spin shrink-0" />Data diff: {phaseLabel(state.phase)}
      </button>
    );
  }

  const text = diffSummaryText(summary);
  const built = nudge === 'built';
  return (
    <div className="flex flex-col gap-1.5">
      {text && (
        <button onClick={showImpact} title="Show the data diff in the Impact tab"
          className={`flex items-start gap-1.5 text-left text-[11px] hover:underline ${summary.failed ? 'text-red-300' : summary.differ ? 'text-amber-300' : 'text-emerald-300'}`}>
          <Database size={12} className="mt-0.5 shrink-0" />
          <span>Data vs {baseTarget}: {text}{summary.finishedAt ? ` · ${relativeTime(summary.finishedAt)}` : ''}</span>
        </button>
      )}
      {summary.items.length > 0 && (
        <DiffResultChips summary={summary} limit={CHIP_LIMIT}
          onOpen={(uid) => openBottomTab('impact', { impactMode: 'working', dataDiff: true, openDiff: uid })} />
      )}
      {(!text || built) && (
        <button onClick={() => start(built ? false : readBuildPreference())}
          title={built ? 'Your build finished; compare the changed models with prod without building again' : `Compare the changed models' rows in dev with ${baseTarget}`}
          className="flex items-center justify-center gap-1.5 py-1 text-xs rounded border border-brand-800 bg-brand-900/30 text-brand-300 transition-colors hover:bg-brand-800/50">
          <Play size={12} />
          {built ? 'Build finished: diff' : 'Diff'} {diffable.length} changed model{diffable.length === 1 ? '' : 's'} vs {baseTarget}
        </button>
      )}
      {state.startError && <p className="text-[11px] text-red-400">{state.startError}</p>}
    </div>
  );
}
