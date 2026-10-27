import { Loader2, RefreshCw } from 'lucide-react';
import type { LineageNotReadyReason } from '../../../../lib/propagationApi';
import { useColumnLineageData } from '../../lib/useColumnLineageData';

const COPY: Record<LineageNotReadyReason, string> = {
  missing: 'Needs column lineage, which hasn’t been computed for this project yet.',
  running: 'Column lineage is being computed…',
  outdated: 'Column lineage needs a refresh: the last scan doesn’t record how each column is derived.',
  error: 'The last column lineage scan failed.',
};

/** Why a lineage feature can't run yet, with a button to (re)compute column lineage. */
export function LineageNotReadyNotice({ projectId, reason, compact = false, outdated }: {
  projectId: number;
  reason: LineageNotReadyReason;
  compact?: boolean;
  /** What an older scan lacks, for this feature (defaults to propagation's transform kinds). */
  outdated?: string;
}) {
  const lineage = useColumnLineageData(projectId, true);
  const busy = lineage.running || reason === 'running';
  const progress = lineage.compiling
    ? 'Compiling…'
    : lineage.progress ? `${lineage.progress.checked} / ${lineage.progress.total} models` : null;

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? 'text-[11px]' : 'text-xs'} text-gray-500`}>
      <span>{busy ? COPY.running : reason === 'outdated' && outdated ? outdated : COPY[reason]}</span>
      {busy && progress && <span className="text-gray-600">{progress}</span>}
      {!busy && (
        <button
          onClick={lineage.start}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-surface-elevated border border-gray-700 text-gray-300 hover:bg-gray-700"
        >
          <RefreshCw size={11} /> Refresh column lineage
        </button>
      )}
      {busy && <Loader2 size={12} className="animate-spin text-brand-400" />}
      {lineage.error && <span className="text-red-400">{lineage.error}</span>}
    </div>
  );
}
