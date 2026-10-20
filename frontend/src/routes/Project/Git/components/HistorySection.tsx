import { HistoryPanel } from './HistoryPanel';
import { PaneSectionHeader, usePersistedOpen } from './PaneSection';

const OPEN_KEY = 'wickd:git-history-open';

interface Props {
  projectId: number;
  selectedPath: string | null;
}

/**
 * Collapsible Commit History section (collapsed by default). When open it fills the rest of the panel,
 * splitting it evenly with Changes if that's open too.
 */
export function HistorySection({ projectId, selectedPath }: Props) {
  const [open, toggle] = usePersistedOpen(OPEN_KEY, false);

  return (
    <div className={open ? 'flex-1 min-h-48 flex flex-col' : 'shrink-0'}>
      <PaneSectionHeader title="Commit History" open={open} onToggle={toggle} />
      {open && (
        <div className="flex-1 min-h-0">
          <HistoryPanel projectId={projectId} selectedPath={selectedPath} />
        </div>
      )}
    </div>
  );
}
