import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import type { DepsState } from './usePackages';
import { diffIsEmpty, type LockChange } from './packagesView';

function ChangeLine({ change, kind }: { change: LockChange; kind: 'added' | 'removed' | 'changed' }) {
  const sign = { added: '+', removed: '−', changed: '~' }[kind];
  const tone = { added: 'text-green-400', removed: 'text-red-400', changed: 'text-amber-300' }[kind];
  return (
    <li className="font-mono text-[11px] text-gray-300">
      <span className={`inline-block w-3 ${tone}`}>{sign}</span>
      {change.key}{' '}
      <span className="text-gray-500">
        {kind === 'changed' ? `${change.from ?? '—'} → ${change.to ?? '—'}` : (change.to ?? change.from ?? '')}
      </span>
    </li>
  );
}

/** `dbt deps` progress, then what it changed in package-lock.yml. Output is in the run log. */
export function DepsBanner({ state, onDismiss }: { state: DepsState; onDismiss: () => void }) {
  if (state.phase === 'idle') return null;
  if (state.phase === 'running') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-300 bg-surface-elevated border border-gray-800 rounded-lg">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Running <span className="font-mono">{state.command}</span>… output is in the Execution DAG / Project Logs tabs
      </div>
    );
  }
  const { diff, ok } = state;
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 text-xs bg-surface-elevated border border-gray-800 rounded-lg">
      <div className="flex items-center gap-2">
        {ok ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <XCircle className="w-3.5 h-3.5 text-red-400" />}
        <span className={`flex-1 ${ok ? 'text-gray-200' : 'text-red-300'}`}>
          {ok ? 'dbt deps finished' : 'dbt deps failed: see the run log'}
          {ok && diffIsEmpty(diff) ? ': package-lock.yml unchanged' : ''}
        </span>
        <button type="button" onClick={onDismiss} className="text-gray-500 hover:text-gray-300" title="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {!diffIsEmpty(diff) && (
        <ul className="flex flex-col gap-0.5 pl-5">
          {diff.changed.map((c) => <ChangeLine key={`c-${c.key}`} change={c} kind="changed" />)}
          {diff.added.map((c) => <ChangeLine key={`a-${c.key}`} change={c} kind="added" />)}
          {diff.removed.map((c) => <ChangeLine key={`r-${c.key}`} change={c} kind="removed" />)}
        </ul>
      )}
    </div>
  );
}
