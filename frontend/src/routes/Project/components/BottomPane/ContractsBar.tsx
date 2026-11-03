import { useState } from 'react';
import { AlertTriangle, FileCheck2, Info, Loader2, Play, RefreshCw, Type } from 'lucide-react';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { UpgradeModal } from '../UpgradeModal';
import type { ContractCheckState } from '../../lib/useContractCheck';
import { checkMatchesBase, phaseLabel } from '../../lib/contractChecks';

interface Props {
  state: ContractCheckState;
  /** Branch mode: the base picked (null = server default) and what the server resolved it to. */
  base: string | null;
  resolvedBase: string | null;
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const BUTTON = 'flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-300 transition-colors hover:border-brand-600 hover:text-brand-300 disabled:opacity-40';

/** Contract check controls and status above the findings (Uncommitted / Branch modes, Pro). */
export function ContractsBar({ state, base, resolvedBase }: Props) {
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const { check, running } = state;

  if (state.locked) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
        <span>Contract checks find columns your changes remove, rename or retype that something downstream still uses.</span>
        <ProFeatureButton onClick={() => setUpgradeOpen(true)}>Unlock contract checks</ProFeatureButton>
        {upgradeOpen && <UpgradeModal feature="Contract checks" onClose={() => setUpgradeOpen(false)} />}
      </div>
    );
  }

  const matches = !check || checkMatchesBase(check, base, resolvedBase);
  const start = (types: boolean) => state.start(base, types);
  const done = check?.status === 'done' && matches;

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="flex items-center gap-1.5 mr-1 text-[11px] font-semibold uppercase tracking-wider text-brand-300">
          <FileCheck2 size={13} />Contract check
        </span>
        {running ? (
          <span className="flex items-center gap-1.5 text-brand-300"><Loader2 size={12} className="animate-spin" />{phaseLabel(state.phase)}</span>
        ) : (
          <>
            <button onClick={() => start(false)} className={BUTTON}
              title="Compile your changes and the base, then compare each changed model's columns (no warehouse queries)">
              {done ? <RefreshCw size={12} /> : <Play size={12} />}{done ? 'Re-check' : 'Check contracts'}
            </button>
            <button onClick={() => start(true)} className={BUTTON}
              title="Also read both sides' column types from the warehouse (an empty LIMIT 0 query per model on your target)">
              <Type size={12} />Check types
            </button>
          </>
        )}
        {done && check && (
          <span className="text-[11px] text-gray-500">
            Checked {when(check.finished_at)}{check.base_sha ? ` against ${check.scope === 'branch' ? `${check.base} (${check.base_sha})` : `HEAD (${check.base_sha})`}` : ''}
            {check.target ? ` on ${check.target}` : ''}{check.types ? ', with types' : ''}
          </span>
        )}
        {state.stale && !running && (
          <span className="flex items-center gap-1 text-[11px] text-amber-300/80"><AlertTriangle size={11} />Files changed since; re-check</span>
        )}
        {check && !matches && !running && <span className="text-[11px] text-gray-500">The last check was against {check.base}.</span>}
      </div>
      {(state.startError || state.loadError) && <p className="text-red-400">{state.startError ?? state.loadError}</p>}
      {check?.status === 'error' && matches && !running && <p className="text-red-400 whitespace-pre-wrap">{check.error_message}</p>}
      {done && check && check.notes.map((n) => (
        <p key={n} className="flex items-start gap-1.5 text-[11px] text-gray-500"><Info size={11} className="mt-0.5 shrink-0" />{n}</p>
      ))}
    </div>
  );
}
