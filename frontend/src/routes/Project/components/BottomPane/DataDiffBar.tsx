import { useState } from 'react';
import { Database, Info, Loader2, Play, Square } from 'lucide-react';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { UpgradeModal } from '../UpgradeModal';
import type { DataDiffState } from '../../lib/useDataDiff';
import { phaseLabel, readBuildPreference, writeBuildPreference } from '../../lib/dataDiff';

const BUTTON = 'flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-300 transition-colors hover:border-brand-600 hover:text-brand-300 disabled:opacity-40';

interface Props {
  state: DataDiffState;
  /** changed models that can be diffed */
  diffable: string[];
  /** the targets of the latest diff, when there is one */
  targets: { dev: string | null; prod: string | null } | null;
  onDiff: (uniqueIds: string[], build: boolean) => void;
}

/** Data diff controls (Uncommitted / Branch modes, Pro): diff every changed model at once. */
export function DataDiffBar({ state, diffable, targets, onDiff }: Props) {
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [build, setBuild] = useState(readBuildPreference);

  if (state.locked) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
        <span>Data diff builds your changed models in dev and compares their rows with prod: added, removed and changed rows, per column.</span>
        <ProFeatureButton onClick={() => setUpgradeOpen(true)}>Unlock data diff</ProFeatureButton>
        {upgradeOpen && <UpgradeModal feature="Data diff" onClose={() => setUpgradeOpen(false)} />}
      </div>
    );
  }

  const toggleBuild = () => {
    setBuild(!build);
    writeBuildPreference(!build);
  };

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-300">
          <Database size={13} className="text-brand-400" />Data diff
        </span>
        {targets?.prod && (
          <span className="text-[11px] text-gray-500 font-mono">{targets.dev ?? 'dev'} → {targets.prod}</span>
        )}
        {state.running ? (
          <>
            <span className="flex items-center gap-1.5 text-brand-300"><Loader2 size={12} className="animate-spin" />{phaseLabel(state.phase)}</span>
            <button onClick={state.cancel} className={BUTTON} title="Stop the diff and the dbt command it's running">
              <Square size={11} />Cancel
            </button>
          </>
        ) : (
          <button onClick={() => onDiff(diffable, build)} disabled={diffable.length === 0} className={BUTTON}
            title={build ? 'dbt run the changed models on your active target, then compare each with prod' : 'Compare what is already built in dev with prod'}>
            <Play size={12} />Diff {diffable.length} changed model{diffable.length === 1 ? '' : 's'}
          </button>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none"
          title="Runs `dbt run --select <models>` on the active target first. Nothing is ever built on prod.">
          <input type="checkbox" checked={build} onChange={toggleBuild} disabled={state.running} className="accent-brand-500" />
          Build in dev first
        </label>
      </div>
      {(state.startError || state.loadError) && <p className="text-red-400">{state.startError ?? state.loadError}</p>}
      {diffable.length === 0 && !state.running && (
        <p className="flex items-start gap-1.5 text-[11px] text-gray-500"><Info size={11} className="mt-0.5 shrink-0" />
          None of the changed nodes are built models, seeds or snapshots.</p>
      )}
    </div>
  );
}
