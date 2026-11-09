import { AlertTriangle, Database, Loader2, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ModelNode } from '../../../../lib/api';
import { diffBadge, diffRequest, isDiffable, phaseLabel, readBuildPreference, readKeys, staleReason } from '../../lib/dataDiff';
import { useDataDiff } from '../../lib/useDataDiff';
import { openBottomTab } from '../../lib/bottomPaneEvents';
import { relativeTime } from '../../lib/relativeTime';
import { useSlimSettings } from '../slim/useSlimSettings';
import { DiffBadgePill } from '../dataDiff/diffUi';

const BUTTON = 'flex items-center justify-center gap-1.5 py-1.5 text-xs rounded border bg-surface-elevated border-gray-700 text-gray-200 transition-colors hover:border-brand-600 hover:text-brand-300 disabled:opacity-50';

/** The Properties tab's data diff (Pro) for one model: its latest result and a button to diff it with prod. */
export function DataDiffCard({ projectId, model }: { projectId: number; model: ModelNode }) {
  const diffable = isDiffable(model);
  const state = useDataDiff(projectId, diffable);
  const { baseTarget } = useSlimSettings(projectId);
  const navigate = useNavigate();
  if (!diffable || state.locked) return null;

  const latest = state.byModel.get(model.unique_id);
  const badge = latest ? diffBadge(latest) : null;
  const thisRunning = latest?.status === 'running';
  const stale = latest ? staleReason(latest) : '';
  const prod = latest?.prod_target ?? baseTarget;
  const openDetails = () => openBottomTab('impact', { openDiff: model.unique_id });
  const start = () => void state.start(diffRequest(readKeys(projectId), [model.unique_id], readBuildPreference(), 'working', null));

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Data diff</span>
      <div className="flex flex-col gap-2 bg-surface-elevated/40 rounded-lg p-3">
        {thisRunning ? (
          <span className="flex items-center gap-1.5 text-xs text-brand-300"><Loader2 className="w-3.5 h-3.5 animate-spin" />{phaseLabel(state.phase)}</span>
        ) : badge ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-400">
            <span>vs <span className="font-mono">{prod}</span>:</span>
            <DiffBadgePill badge={badge} onClick={openDetails} />
            {latest?.finished_at && <span className="text-[11px] text-gray-500">{relativeTime(latest.finished_at)}</span>}
          </div>
        ) : (
          <span className="text-xs text-gray-400">Compare this model's rows in dev with {baseTarget || 'prod'}: added, removed and changed.</span>
        )}
        {stale && !thisRunning && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
            <span>
              Dev rebuilt by {latest?.dev_rebuilt_by ? `dbt ${latest.dev_rebuilt_by}` : 'a dbt command'}
              {latest?.dev_rebuilt_at ? ` ${relativeTime(latest.dev_rebuilt_at)}` : ''}, after this diff. Diff again to compare the current data.
            </span>
          </p>
        )}
        {baseTarget ? (
          <div className={`grid gap-1.5 ${badge ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {badge && <button onClick={openDetails} className={BUTTON}><Database className="w-3.5 h-3.5" />Details</button>}
            <button onClick={start} disabled={state.running}
              title={state.running ? 'A data diff is already running' : readBuildPreference() ? `dbt run this model in dev, then compare it with ${baseTarget}` : `Compare what is built in dev with ${baseTarget}`}
              className={BUTTON}>
              <Play className="w-3.5 h-3.5" />{badge ? 'Diff again' : `Diff vs ${baseTarget}`}
            </button>
          </div>
        ) : (
          <button onClick={() => navigate(`/projects/${projectId}/environment`)} className="text-left text-[11px] text-amber-300 hover:underline">
            Set DIFF_BASE_TARGET in Environment to diff with prod
          </button>
        )}
        {state.startError && <p className="text-[10px] text-red-400">{state.startError}</p>}
      </div>
    </div>
  );
}
