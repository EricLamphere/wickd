import { useState } from 'react';
import { PaneTabBar } from '../Project/components/BottomPane/PaneTabBar';
import { TerminalArea } from '../Project/components/BottomPane/TerminalArea';
import { usePaneResize } from '../Project/components/BottomPane/usePaneResize';
import { primaryProjectsFolder } from '../../components/setup/types';
import { WorkspaceLogPanel } from './WorkspaceLogPanel';

type HomePaneTab = 'terminal' | 'project-logs' | 'api-logs';

const TABS: { id: HomePaneTab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'project-logs', label: 'Project Logs' },
  { id: 'api-logs', label: 'API Logs' },
];

/**
 * The home page's bottom pane: Terminal (in the first projects folder, else ~), Project Logs
 * (combined docs runs: init steps + docs generate) and API Logs.
 */
export function HomeBottomPane({ projectsPath }: { projectsPath: string | null | undefined }) {
  const { open, setOpen, height, onBarMouseDown } = usePaneResize();
  const [activeTab, setActiveTab] = useState<HomePaneTab>('terminal');
  const cwd = projectsPath === undefined ? null : primaryProjectsFolder(projectsPath ?? '') || '~';

  return (
    <div className="shrink-0 bg-surface-panel border-t border-gray-700 flex flex-col">
      <PaneTabBar
        tabs={TABS}
        activeTab={activeTab}
        open={open}
        onSelect={(id) => { setOpen(true); setActiveTab(id); }}
        onToggle={() => setOpen((v) => !v)}
        onBarMouseDown={onBarMouseDown}
      />
      <TerminalArea cwd={cwd} active={open && activeTab === 'terminal'} height={height} loadingLabel="Loading…" />
      {open && activeTab !== 'terminal' && (
        <div style={{ height }} className="overflow-hidden flex flex-col">
          <WorkspaceLogPanel key={activeTab} kind={activeTab === 'project-logs' ? 'project' : 'api'} />
        </div>
      )}
    </div>
  );
}
