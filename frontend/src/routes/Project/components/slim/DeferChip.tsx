import { GitMerge, X } from 'lucide-react';
import { alertError } from '../../../../lib/dialogs';
import { deferLabel } from '../../../../lib/slimBuild';
import { useSlimSettings } from './useSlimSettings';

/** Header chip while "Defer to prod" is on: runs silently read production data. Click to turn off. */
export function DeferChip({ projectId }: { projectId: number }) {
  const settings = useSlimSettings(projectId);
  if (settings.defer === 'off') return null;
  const label = deferLabel(settings);
  return (
    <button
      type="button"
      onClick={() => settings.setDefer('off').catch(alertError)}
      title={`${label}${settings.defer === 'favor' ? ' (favor state)' : ''}: unbuilt parents are read from production. Click to stop deferring.`}
      className="group flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-800 bg-amber-950/40 text-[11px] text-amber-200 whitespace-nowrap hover:border-amber-600"
    >
      <GitMerge size={11} />
      {label}
      <X size={11} className="opacity-50 group-hover:opacity-100" />
    </button>
  );
}
