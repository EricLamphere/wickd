import { Loader2, Workflow } from 'lucide-react';
import { useColumnLineageData } from '../../lib/useColumnLineageData';

/** Build changed preview: the smallest safe set needs a fresh column lineage scan. The dialog
 *  previews again on column_lineage_finished. */
export function LoadLineageNotice({ projectId }: { projectId: number }) {
  const lineage = useColumnLineageData(projectId, true);
  const progress = lineage.compiling
    ? 'Compiling…'
    : lineage.progress ? `${lineage.progress.checked} / ${lineage.progress.total} models` : null;
  return (
    <div className="flex flex-wrap items-center gap-2 mx-4 mt-2 px-3 py-2 rounded border border-amber-900/60 bg-amber-950/40 text-xs text-amber-300">
      <Workflow size={13} className="shrink-0" />
      <span>The smallest safe set needs column lineage from your latest parse.</span>
      {lineage.running ? (
        <span className="flex items-center gap-1.5 text-amber-300">
          <Loader2 size={12} className="animate-spin" />
          Loading column lineage{progress ? ` · ${progress}` : '…'}
        </span>
      ) : (
        <button
          onClick={lineage.start}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-600 text-white font-medium hover:bg-amber-500"
        >
          <Workflow size={11} /> Load column lineage
        </button>
      )}
      {lineage.error && <span className="text-red-400">{lineage.error}</span>}
    </div>
  );
}
