import { useEffect, useState } from 'react';
import { type GraphDto } from '../../../../lib/api';
import { RunPanel } from './RunPanel';
import { LogPanel } from './LogPanel';
import { PaneTabBar } from './PaneTabBar';
import { TerminalArea } from './TerminalArea';
import { usePaneResize } from './usePaneResize';
import { NodeDagPanel } from './NodeDagPanel';
import { NodeSqlPanel } from './NodeSqlPanel';
import { ImpactPanel } from './ImpactPanel';
import { OPEN_BOTTOM_TAB_EVENT, type OpenBottomTabDetail } from '../../lib/bottomPaneEvents';
import type { ImpactMode } from '../../lib/impactChanges';
import { useBuildNudgeTracker } from '../../lib/buildNudge';

export type PaneTabId = 'run' | 'node-dag' | 'node-sql' | 'impact' | 'project-logs' | 'api-logs' | 'terminal';

const PANE_TABS: { id: PaneTabId; label: string }[] = [
  { id: 'node-dag', label: 'Node DAG' },
  { id: 'node-sql', label: 'Node SQL' },
  { id: 'run', label: 'Execution DAG' },
  { id: 'impact', label: 'Impact' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'project-logs', label: 'Project Logs' },
  { id: 'api-logs', label: 'API Logs' },
];

interface BottomPaneProps {
  projectId: number;
  graph: GraphDto | null;
  projectPath: string | null;
  /** shown as the Execution DAG's node for commands without DAG nodes (compile, docs generate…) */
  projectName: string;
  selectedNodeId: string | null;
  selectedNodeIds: readonly string[];
  /** DAG column selection (`<uid>::<column>`), which drives column-level impact. */
  selectedColumns: readonly string[];
}

export function BottomPane({ projectId, graph, projectPath, projectName, selectedNodeId, selectedNodeIds, selectedColumns }: BottomPaneProps) {
  const { open, setOpen, height, onBarMouseDown } = usePaneResize();
  const [activeTab, setActiveTab] = useState<PaneTabId>('run');
  // Impact tab source + branch base live here so they survive switching tabs
  const [impactMode, setImpactMode] = useState<ImpactMode>('selection');
  const [impactBase, setImpactBase] = useState<string | null>(null);
  const [impactColumnLevel, setImpactColumnLevel] = useState(false);
  const [impactContracts, setImpactContracts] = useState(false);
  const [impactDataDiff, setImpactDataDiff] = useState(false);
  // a model whose data diff another page asked to open (consumed by the Impact tab)
  const [impactOpenDiff, setImpactOpenDiff] = useState<string | null>(null);
  useBuildNudgeTracker(projectId);

  // Other components (e.g. the SidePane impact card) can ask for a tab
  useEffect(() => {
    const onOpenTab = (e: Event) => {
      const { tab, impactMode: mode, contracts, dataDiff, openDiff } = (e as CustomEvent<OpenBottomTabDetail>).detail;
      setActiveTab(tab);
      if (mode) setImpactMode(mode);
      if (contracts) setImpactContracts(true);
      if (dataDiff) setImpactDataDiff(true);
      if (openDiff) setImpactOpenDiff(openDiff);
      setOpen(true);
    };
    window.addEventListener(OPEN_BOTTOM_TAB_EVENT, onOpenTab);
    return () => window.removeEventListener(OPEN_BOTTOM_TAB_EVENT, onOpenTab);
  }, [setOpen]);

  const isTerminalActive = open && activeTab === 'terminal';

  return (
    <div className="shrink-0 bg-surface-panel border-t border-gray-700 flex flex-col">
      <PaneTabBar
        tabs={PANE_TABS}
        activeTab={activeTab}
        open={open}
        onSelect={(id) => { setOpen(true); setActiveTab(id); }}
        onToggle={() => setOpen((v) => !v)}
        onBarMouseDown={onBarMouseDown}
      />

      {/* RunPanel — always mounted */}
      <div
        style={{ height: open && activeTab === 'run' ? height : 0 }}
        className="overflow-hidden flex flex-col"
        aria-hidden={!(open && activeTab === 'run')}
      >
        <RunPanel projectId={projectId} projectName={projectName} graph={graph} />
      </div>

      {/* Node DAG — mounted only while visible so it centres against the real pane size */}
      {open && activeTab === 'node-dag' && (
        <div style={{ height }} className="overflow-hidden flex flex-col">
          <NodeDagPanel projectId={projectId} graph={graph} selectedNodeId={selectedNodeId} />
        </div>
      )}

      {open && activeTab === 'node-sql' && (
        <div style={{ height }} className="overflow-hidden flex flex-col">
          <NodeSqlPanel projectId={projectId} graph={graph} selectedNodeId={selectedNodeId} />
        </div>
      )}

      {open && activeTab === 'impact' && (
        <div style={{ height }} className="overflow-hidden flex flex-col">
          <ImpactPanel
            projectId={projectId}
            graph={graph}
            selectedNodeId={selectedNodeId}
            selectedNodeIds={selectedNodeIds}
            selectedColumns={selectedColumns}
            mode={impactMode}
            onModeChange={setImpactMode}
            base={impactBase}
            onBaseChange={setImpactBase}
            columnLevel={impactColumnLevel}
            onColumnLevelChange={setImpactColumnLevel}
            contracts={impactContracts}
            onContractsChange={setImpactContracts}
            dataDiff={impactDataDiff}
            onDataDiffChange={setImpactDataDiff}
            openDiff={impactOpenDiff}
            onOpenDiffConsumed={() => setImpactOpenDiff(null)}
          />
        </div>
      )}

      <TerminalArea cwd={projectPath} active={isTerminalActive} height={height} />

      {/* Logs panels */}
      {open && (activeTab === 'project-logs' || activeTab === 'api-logs') && (
        <div style={{ height }} className="overflow-hidden flex flex-col">
          {activeTab === 'project-logs' && <LogPanel projectId={projectId} logType="project" />}
          {activeTab === 'api-logs' && <LogPanel projectId={projectId} logType="api" />}
        </div>
      )}

    </div>
  );
}
