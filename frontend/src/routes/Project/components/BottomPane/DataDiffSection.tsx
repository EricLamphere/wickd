import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Database, Info, Loader2, Play, Settings2, Square, X } from 'lucide-react';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { UpgradeModal } from '../UpgradeModal';
import type { DataDiffState } from '../../lib/useDataDiff';
import { diffSummaryText, phaseLabel, readBuildPreference, writeBuildPreference, type DiffSummary } from '../../lib/dataDiff';
import { dismissBuildNudge, useBuildNudge } from '../../lib/buildNudge';
import { relativeTime } from '../../lib/relativeTime';
import { DiffResultChips } from '../dataDiff/diffUi';
import { CHECK_BUTTON, LockedStatus, ProCheckSection } from './ProCheckSection';

const INTRO = 'Data diff compares your changed models in dev with prod: rows added, removed and changed, per column.';

interface Props {
  projectId: number;
  state: DataDiffState;
  /** changed models that can be diffed */
  diffable: string[];
  /** the changed models plus the diffable models downstream of them */
  diffableImpacted: string[];
  /** the impacted models' latest diffs */
  summary: DiffSummary;
  /** the targets of the latest diff, when there is one */
  targets: { dev: string | null; prod: string | null } | null;
  /** DIFF_BASE_TARGET ('' = not set: diffs can't start) */
  baseTarget: string;
  onDiff: (uniqueIds: string[], build: boolean) => void;
  onOpen: (uniqueId: string) => void;
}

const HEADER = { storageKey: 'wickd:impact-data-diff-open', icon: <Database size={13} />, title: 'Data diff' };

/** The Impact tab's Data diff section (Uncommitted / Branch modes, Pro): diff every changed model, see how each came out. */
export function DataDiffSection(props: Props) {
  const { projectId, state, diffable, diffableImpacted, summary, baseTarget, onDiff, onOpen } = props;
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const navigate = useNavigate();
  const nudge = useBuildNudge(projectId);

  if (state.locked) {
    return (
      <ProCheckSection {...HEADER} status={<LockedStatus />}>
        <div className="flex flex-wrap items-center gap-3 text-gray-400">
          <span>{INTRO} Run it before you merge to catch a change that drops or duplicates rows.</span>
          <ProFeatureButton onClick={() => setUpgradeOpen(true)}>Unlock data diff</ProFeatureButton>
          {upgradeOpen && <UpgradeModal feature="Data diff" onClose={() => setUpgradeOpen(false)} />}
        </div>
      </ProCheckSection>
    );
  }

  return (
    <ProCheckSection {...HEADER} status={<Status {...props} />} actions={<Actions {...props} />}>
      {!baseTarget && (
        <p className="flex flex-wrap items-center gap-2 text-amber-300">
          <Info size={12} className="shrink-0" />
          Set DIFF_BASE_TARGET to the target to compare with (e.g. prod) to start diffing.
          <button onClick={() => navigate(`/projects/${projectId}/environment`)} className={CHECK_BUTTON}>
            <Settings2 size={11} />Environment
          </button>
        </p>
      )}
      {nudge === 'built' && baseTarget && diffable.length > 0 && !state.running && (
        <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 rounded border border-brand-800/60 bg-brand-900/20 text-brand-200">
          <span>Your build finished. Compare with prod now; the models are already built, so this skips the build.</span>
          <button onClick={() => onDiff(diffable, false)} className={CHECK_BUTTON}><Play size={12} />Diff changed</button>
          {diffableImpacted.length > diffable.length && (
            <button onClick={() => onDiff(diffableImpacted, false)} className={CHECK_BUTTON}><Play size={12} />Diff all impacted</button>
          )}
          <button onClick={() => dismissBuildNudge(projectId)} className="ml-auto text-gray-500 hover:text-gray-300" aria-label="Dismiss"><X size={12} /></button>
        </div>
      )}
      {(state.startError || state.loadError) && <p className="text-red-400">{state.startError ?? state.loadError}</p>}
      {summary.items.length > 0
        ? <DiffResultChips summary={summary} onOpen={onOpen} />
        : diffable.length > 0 && !state.running && <p className="text-[11px] text-gray-500">{INTRO} No diff yet for these changes.</p>}
      {diffable.length === 0 && !state.running && (
        <p className="flex items-start gap-1.5 text-[11px] text-gray-500"><Info size={11} className="mt-0.5 shrink-0" />
          None of the changed nodes are built models, seeds or snapshots.</p>
      )}
    </ProCheckSection>
  );
}

/** Header line: what's running, or how the changed models' latest diffs came out. */
function Status({ state, summary, targets, baseTarget }: Props) {
  if (state.running) {
    return <span className="flex items-center gap-1.5 text-brand-300"><Loader2 size={12} className="animate-spin" />{phaseLabel(state.phase)}</span>;
  }
  const text = diffSummaryText(summary);
  if (!text) return null;
  const tone = summary.failed ? 'text-red-300' : summary.differ ? 'text-amber-300' : 'text-emerald-300';
  const prod = targets?.prod ?? baseTarget;
  return (
    <>
      <span className={tone}>{text}</span>
      <span className="text-[11px] text-gray-500">
        {prod && <span className="font-mono">{targets?.dev ?? 'dev'} → {prod}</span>}
        {summary.finishedAt && ` · ${relativeTime(summary.finishedAt)}`}
      </span>
    </>
  );
}

function Actions({ state, diffable, diffableImpacted, baseTarget, onDiff }: Props) {
  const [build, setBuild] = useState(readBuildPreference);
  const toggleBuild = () => {
    setBuild(!build);
    writeBuildPreference(!build);
  };
  if (state.running) {
    return (
      <button onClick={state.cancel} className={CHECK_BUTTON} title="Stop the diff and the dbt command it's running">
        <Square size={11} />Cancel
      </button>
    );
  }
  const title = (what: string) => (!baseTarget ? 'Set DIFF_BASE_TARGET first'
    : build ? `dbt run ${what} on your active target, then compare each with prod` : `Compare ${what} as already built in dev with prod`);
  return (
    <>
      <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none"
        title="Runs `dbt run --select <models>` on the active target first. Nothing is ever built on prod.">
        <input type="checkbox" checked={build} onChange={toggleBuild} className="accent-brand-500" />
        Build in dev first
      </label>
      <button onClick={() => onDiff(diffable, build)} disabled={diffable.length === 0 || !baseTarget} className={CHECK_BUTTON}
        title={title('the changed models')}>
        <Play size={12} />Diff changed ({diffable.length})
      </button>
      <button onClick={() => onDiff(diffableImpacted, build)} disabled={diffableImpacted.length <= diffable.length || !baseTarget}
        className={CHECK_BUTTON}
        title={diffableImpacted.length <= diffable.length ? 'Nothing diffable downstream of the changed models' : title('the changed models and every built model downstream of them')}>
        <Play size={12} />Diff all impacted ({diffableImpacted.length})
      </button>
    </>
  );
}
