import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Columns3, Copy, Database, FileCheck2 } from 'lucide-react';
import { api } from '../../../../lib/api';
import { summaryFlags, type Impact } from '../../lib/impact';
import type { ImpactMode } from '../../lib/impactChanges';
import { FlagBadge, ImpactCounts } from '../impact/impactUi';
import { ImpactBuildButton } from '../slim/ImpactBuildButton';

const MODES: { id: ImpactMode; label: string; title: string }[] = [
  { id: 'selection', label: 'Selection', title: 'Impact of the node(s) selected in the DAG or Files' },
  { id: 'working', label: 'Uncommitted', title: 'Impact of staged, unstaged and untracked changes' },
  { id: 'branch', label: 'Branch', title: 'Impact of everything on this branch since it left the base, plus uncommitted changes' },
];

const COPIED_RESET_MS = 1500;
const NOTHING_TO_BUILD = 'Only exposures changed; dbt build has nothing to build for them';

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false));
  };
  return [copied, copy];
}

function ColumnLevelToggle({ on, onChange, forced }: { on: boolean; onChange: (on: boolean) => void; forced: boolean }) {
  return (
    <button
      onClick={() => onChange(!on)}
      disabled={forced}
      aria-pressed={on}
      title={forced
        ? 'On while columns are selected on the DAG'
        : 'Column-level impact (Pro): follow only the columns you change, including through filters and joins'}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] shrink-0 transition-colors ${
        on ? 'border-brand-600 bg-brand-900/50 text-brand-200' : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
      }`}
    >
      <Columns3 size={12} />
      Columns
      <span className="px-1 rounded bg-brand-900/70 text-[9px] font-semibold uppercase tracking-wider text-brand-300">Pro</span>
    </button>
  );
}

function ProToggle({ on, onChange, icon, label, title }: {
  on: boolean; onChange: (on: boolean) => void; icon: ReactNode; label: string; title: string;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={title}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] shrink-0 transition-colors ${
        on ? 'border-brand-600 bg-brand-900/50 text-brand-200' : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
      }`}
    >
      {icon}
      {label}
      <span className="px-1 rounded bg-brand-900/70 text-[9px] font-semibold uppercase tracking-wider text-brand-300">Pro</span>
    </button>
  );
}

function ModeSwitch({ mode, onChange }: { mode: ImpactMode; onChange: (m: ImpactMode) => void }) {
  return (
    <div className="flex items-center p-0.5 rounded-md bg-gray-800/70 shrink-0">
      {MODES.map(({ id, label, title }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          title={title}
          className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
            mode === id ? 'bg-surface-panel text-gray-100 shadow-sm' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Base ref picker for Branch mode; `resolved` is what the server defaulted to. */
function BasePicker({ projectId, base, resolved, onChange }: {
  projectId: number;
  base: string | null;
  resolved: string | null;
  onChange: (base: string | null) => void;
}) {
  const { data } = useQuery({
    queryKey: ['git', 'branches', projectId],
    queryFn: () => api.git.branches(projectId),
  });
  const value = base ?? resolved ?? '';
  const names = [...new Set([value, ...(data?.branches ?? []).map((b) => b.name)].filter(Boolean))];
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-gray-500 shrink-0">
      vs
      <select
        value={value}
        onChange={(e) => onChange(e.target.value || null)}
        className="max-w-[10rem] px-1.5 py-0.5 rounded bg-gray-800/70 border border-gray-700 text-xs text-gray-200 focus:outline-none focus:border-brand-600"
      >
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

interface ImpactToolbarProps {
  projectId: number;
  mode: ImpactMode;
  onModeChange: (mode: ImpactMode) => void;
  base: string | null;
  resolvedBase: string | null;
  onBaseChange: (base: string | null) => void;
  impact: Impact | null;
  /** Column-level mode: downstream nodes the node-level view would show but no affected column reaches. */
  prunedCount: number | null;
  columnLevel: boolean;
  onColumnLevelChange: (on: boolean) => void;
  /** Column-level is on because columns are selected on the DAG. */
  columnLevelForced: boolean;
  selector: string;
  /** Contract checks (Pro) in Uncommitted / Branch modes. */
  contracts: boolean;
  onContractsChange: (on: boolean) => void;
  /** Data diff (Pro) in Uncommitted / Branch modes. */
  dataDiff: boolean;
  onDataDiffChange: (on: boolean) => void;
}

export function ImpactToolbar(props: ImpactToolbarProps) {
  const { projectId, mode, onModeChange, impact, selector } = props;
  const [copied, copy] = useCopied();
  const summary = impact?.summary;
  const flags = summary ? summaryFlags(summary) : [];
  const hasSeeds = !!impact && impact.seeds.length > 0;

  const showSummary = hasSeeds && !!summary;
  return (
    <div className="flex flex-col border-b border-gray-800 shrink-0 select-none">
      {/* Row 1: what to analyse, and what to do about it */}
      <div className="flex items-center gap-3 h-9 px-4">
        <ModeSwitch mode={mode} onChange={onModeChange} />
        {mode === 'branch' && (
          <BasePicker projectId={projectId} base={props.base} resolved={props.resolvedBase} onChange={props.onBaseChange} />
        )}
        {mode === 'selection' && (
          <ColumnLevelToggle on={props.columnLevel} onChange={props.onColumnLevelChange} forced={props.columnLevelForced} />
        )}
        {mode !== 'selection' && (
          <>
            <ProToggle on={props.contracts} onChange={props.onContractsChange} icon={<FileCheck2 size={12} />} label="Contracts"
              title="Contract checks (Pro): columns your changes remove, rename or retype that models, tests, exposures or the semantic layer still use" />
            <ProToggle on={props.dataDiff} onChange={props.onDataDiffChange} icon={<Database size={12} />} label="Data diff"
              title="Data diff (Pro): build the changed models in dev and compare their rows with prod (DIFF_BASE_TARGET)" />
          </>
        )}
        {(hasSeeds || mode !== 'selection') && (
          <div className="flex items-center gap-1.5 ml-auto shrink-0">
            {hasSeeds && (
              <button
                onClick={() => copy(selector)}
                disabled={!selector}
                title={selector ? 'Copy the --select value' : NOTHING_TO_BUILD}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy selector'}
              </button>
            )}
            <ImpactBuildButton
              projectId={projectId}
              mode={mode}
              base={props.base ?? props.resolvedBase}
              selector={selector}
              impact={impact}
              columnLevel={props.columnLevel}
            />
          </div>
        )}
      </div>

      {/* Row 2: what the change reaches */}
      {showSummary && (
        <div className="flex items-center gap-3 h-8 px-4 border-t border-gray-800/60 min-w-0">
          {showSummary && summary && (
            <>
              {selector && (
                <code className="px-2 py-0.5 rounded bg-gray-800/80 text-xs text-gray-200 truncate max-w-[28rem]" title={selector}>
                  {selector}
                </code>
              )}
              {summary.downstreamCount === 0
                ? <span className="text-xs text-gray-400 whitespace-nowrap">Nothing downstream</span>
                : <ImpactCounts summary={summary} className="shrink-0 flex-nowrap" />}
              {props.prunedCount !== null && props.prunedCount > 0 && (
                <span className="text-xs text-emerald-400/80 whitespace-nowrap" title="Downstream of the selection, but no affected column reaches them">
                  {props.prunedCount} node{props.prunedCount === 1 ? '' : 's'} unaffected
                </span>
              )}
              {flags.length > 0 && (
                <span className="flex items-center gap-1 shrink-0">
                  {flags.map((f) => <FlagBadge key={f} flag={f} count={summary.flagCounts[f]} />)}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
