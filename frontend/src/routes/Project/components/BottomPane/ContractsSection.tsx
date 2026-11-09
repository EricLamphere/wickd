import { useState, type MouseEvent } from 'react';
import { AlertTriangle, FileCheck2, Info, Loader2, Play, RefreshCw, Type } from 'lucide-react';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { UpgradeModal } from '../UpgradeModal';
import type { ContractCheckState } from '../../lib/useContractCheck';
import { checkMatchesBase, phaseLabel, summarizeCheck, summaryLine } from '../../lib/contractChecks';
import { ContractFindings } from './ContractFindings';
import { CHECK_BUTTON, LockedStatus, ProCheckSection } from './ProCheckSection';

const INTRO = 'Contract checks find columns your changes remove, rename or retype that something downstream still uses.';

interface Props {
  projectId: number;
  state: ContractCheckState;
  /** Branch mode: the base picked (null = server default) and what the server resolved it to. */
  base: string | null;
  resolvedBase: string | null;
  onNodeClick: (e: MouseEvent, uniqueId: string) => void;
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The Impact tab's Contracts section (Uncommitted / Branch modes, Pro): run a check, see what it found. */
export function ContractsSection({ projectId, state, base, resolvedBase, onNodeClick }: Props) {
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const { check, running } = state;
  const header = { storageKey: 'wickd:impact-contracts-open', icon: <FileCheck2 size={13} />, title: 'Contract check' };

  if (state.locked) {
    return (
      <ProCheckSection {...header} status={<LockedStatus />}>
        <div className="flex flex-wrap items-center gap-3 text-gray-400">
          <span>{INTRO}</span>
          <ProFeatureButton onClick={() => setUpgradeOpen(true)}>Unlock contract checks</ProFeatureButton>
          {upgradeOpen && <UpgradeModal feature="Contract checks" onClose={() => setUpgradeOpen(false)} />}
        </div>
      </ProCheckSection>
    );
  }

  const matches = !check || checkMatchesBase(check, base, resolvedBase);
  const done = check?.status === 'done' && matches;
  const start = (types: boolean) => state.start(base, types);

  const actions = running ? null : (
    <>
      <button onClick={() => start(true)} className={CHECK_BUTTON}
        title="Also read both sides' column types from the warehouse (an empty LIMIT 0 query per model on your target)">
        <Type size={12} />Check types
      </button>
      <button onClick={() => start(false)} className={CHECK_BUTTON}
        title="Compile your changes and the base, then compare each changed model's columns (no warehouse queries)">
        {done ? <RefreshCw size={12} /> : <Play size={12} />}{done ? 'Re-check' : 'Check contracts'}
      </button>
    </>
  );

  return (
    <ProCheckSection {...header} status={<Status state={state} done={done} />} actions={actions}>
      {(state.startError || state.loadError) && <p className="text-red-400">{state.startError ?? state.loadError}</p>}
      {check?.status === 'error' && matches && !running && <p className="text-red-400 whitespace-pre-wrap">{check.error_message}</p>}
      {check && !matches && !running && <p className="text-[11px] text-gray-500">The last check was against {check.base}.</p>}
      {done && check && (
        <p className="text-[11px] text-gray-500">
          Checked {when(check.finished_at)}{check.base_sha ? ` against ${check.scope === 'branch' ? `${check.base} (${check.base_sha})` : `HEAD (${check.base_sha})`}` : ''}
          {check.target ? ` on ${check.target}` : ''}{check.types ? ', with types' : ''}
        </p>
      )}
      {done && check && check.notes.map((n) => (
        <p key={n} className="flex items-start gap-1.5 text-[11px] text-gray-500"><Info size={11} className="mt-0.5 shrink-0" />{n}</p>
      ))}
      {done && check
        ? <ContractFindings projectId={projectId} results={check.results} onNodeClick={onNodeClick} />
        : !running && <p className="text-[11px] text-gray-500">{INTRO} No check yet for these changes.</p>}
    </ProCheckSection>
  );
}

/** Header line: what's running, or what the latest check found. */
function Status({ state, done }: { state: ContractCheckState; done: boolean }) {
  if (state.running) {
    return <span className="flex items-center gap-1.5 text-brand-300"><Loader2 size={12} className="animate-spin" />{phaseLabel(state.phase)}</span>;
  }
  if (!done || !state.check) return null;
  const summary = summarizeCheck(state.check.results);
  const line = summaryLine(summary);
  const tone = !line ? 'text-emerald-300' : summary.severity === 'error' ? 'text-red-300' : 'text-amber-300';
  return (
    <>
      <span className={tone}>{line ?? 'no breaking changes'}</span>
      {state.stale && <span className="flex items-center gap-1 text-[11px] text-amber-300/80"><AlertTriangle size={11} />Files changed since; re-check</span>}
    </>
  );
}
