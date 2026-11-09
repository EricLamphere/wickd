import { useState } from 'react';
import { GitMerge } from 'lucide-react';
import { alertError } from '../../../../lib/dialogs';
import type { DeferMode } from '../../../../lib/slimBuild';
import { useSlimSettings } from './useSlimSettings';

const DEFER_TITLE = 'Defer to prod (--defer --state): parents you haven\'t built in dev are read from production '
  + '(STATE_SOURCE), so your dev schema doesn\'t need the whole upstream DAG. Applies to every run, build and test until turned off.';
const FAVOR_TITLE = '--favor-state: read production even for parents that do exist in dev';

function Pill({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs transition-colors select-none ${
        on ? 'bg-amber-950/40 border-amber-700 text-amber-200' : 'bg-surface-elevated border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  );
}

/** Sticky per project "Defer to prod" toggle for the side pane run grid. */
export function DeferToggle({ projectId }: { projectId: number }) {
  const { defer, setDefer } = useSlimSettings(projectId);
  const [saving, setSaving] = useState(false);
  const change = async (mode: DeferMode) => {
    setSaving(true);
    try {
      await setDefer(mode);
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={`flex items-center gap-2 ${saving ? 'opacity-60 pointer-events-none' : ''}`}>
      <Pill on={defer !== 'off'} onClick={() => change(defer === 'off' ? 'defer' : 'off')} title={DEFER_TITLE}>
        <GitMerge size={12} />
        Defer to prod
      </Pill>
      {defer !== 'off' && (
        <Pill on={defer === 'favor'} onClick={() => change(defer === 'favor' ? 'defer' : 'favor')} title={FAVOR_TITLE}>
          favor state
        </Pill>
      )}
    </div>
  );
}
