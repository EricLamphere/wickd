interface Props {
  projectId: number;
  currentBranch: string | null;
  ahead: number;
  behind: number;
  /** Receives the chip's bounding rect so the branch picker can anchor below it. */
  onBranchClick: (anchor: DOMRect) => void;
  syncing: boolean;
}

/** Compact branch chip + push/pull button for the Source Control title row. */
export function BranchControls({ projectId, currentBranch, ahead, behind, onBranchClick, syncing }: Props) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      <button
        onClick={(e) => onBranchClick(e.currentTarget.getBoundingClientRect())}
        title="Switch branch"
        className="flex items-center gap-1 min-w-0 h-5 px-1.5 rounded text-[11px] text-zinc-300 hover:bg-surface-elevated"
      >
        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M12 5v7m0 0l-3-3m3 3l3-3M6 19a2 2 0 100-4 2 2 0 000 4zm12 0a2 2 0 100-4 2 2 0 000 4zM6 7a2 2 0 100-4 2 2 0 000 4z" />
        </svg>
        <span className="max-w-[120px] truncate">{currentBranch ?? 'detached HEAD'}</span>
        {(ahead > 0 || behind > 0) && (
          <span className="shrink-0 text-zinc-500">
            {ahead > 0 && `↑${ahead}`}{behind > 0 && `↓${behind}`}
          </span>
        )}
      </button>

      <button
        onClick={() => {
          // push/pull handled at parent via SSE — just trigger
          if (behind > 0) {
            fetch(`/api/projects/${projectId}/git/pull`, { method: 'POST' });
          } else {
            fetch(`/api/projects/${projectId}/git/push`, { method: 'POST' });
          }
        }}
        disabled={syncing}
        title={behind > 0 ? 'Pull' : 'Push'}
        className="shrink-0 p-0.5 rounded text-zinc-400 hover:bg-surface-elevated hover:text-gray-200 disabled:opacity-40"
      >
        {behind > 0 ? (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        )}
      </button>
    </div>
  );
}
