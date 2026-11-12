import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Outlet } from 'react-router-dom';
import { api } from '../../lib/api';
import { useModifierKeyClass } from '../../lib/useModifierKeyClass';
import { ActivityBubble } from './components/ActivityBubble/ActivityBubble';
import { BottomPane } from './components/BottomPane';
import { CommandPalette } from './components/CommandPalette';
import { RefactorHost } from './components/refactor/RefactorHost';
import { ScheduleFailureToast } from '../../components/schedule/ScheduleFailureToast';
import { WickyPane } from './components/Wicky/WickyPane';
import { useStatePreviewCache } from './components/slim/useStatePreviewCache';
import { CommandPaletteContext } from './lib/commandPaletteContext';
import { ownsShortcuts } from '../../lib/keyboardOwner';
import {
  SelectedNodeContext,
  SelectedColumnsContext,
  SelectedNodeIdsContext,
  SetSelectedColumnsContext,
  SetSelectedNodeContext,
  SetSelectedNodeIdsContext,
} from './lib/selectedNodeContext';

export default function ProjectLayout() {
  useModifierKeyClass();
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  useStatePreviewCache(id);

  const { data: graph } = useQuery({
    queryKey: ['models', id],
    queryFn: () => api.models.graph(id),
    refetchInterval: false,
    enabled: !!id,
  });

  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.projects.get(id),
    refetchInterval: false,
    enabled: !!id,
  });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<readonly string[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<readonly string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');

  const openPalette = useCallback((initialQuery = '') => {
    setPaletteQuery(initialQuery);
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteQuery('');
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // an editor with its own ⌘K (the dashboard text widget's Markdown link) keeps it
        if (ownsShortcuts(e.target)) return;
        e.preventDefault();
        setPaletteOpen((open) => {
          if (open) {
            setPaletteQuery('');
            return false;
          }
          setPaletteQuery('');
          return true;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const ctxValue = useMemo(
    () => ({ open: openPalette, close: closePalette }),
    [openPalette, closePalette],
  );

  return (
    <CommandPaletteContext.Provider value={ctxValue}>
      <SetSelectedNodeContext.Provider value={setSelectedNodeId}>
      <SelectedNodeContext.Provider value={selectedNodeId}>
      <SetSelectedNodeIdsContext.Provider value={setSelectedNodeIds}>
      <SelectedNodeIdsContext.Provider value={selectedNodeIds}>
      <SetSelectedColumnsContext.Provider value={setSelectedColumns}>
      <SelectedColumnsContext.Provider value={selectedColumns}>
      <div className="flex flex-row h-full overflow-hidden">
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        <div className="relative flex-1 min-h-0">
          <div className="h-full overflow-auto">
            <Outlet />
          </div>
          <ActivityBubble key={id} projectId={id} />
        </div>
        <BottomPane
          projectId={id}
          graph={graph ?? null}
          projectPath={project?.path ?? null}
          projectName={project?.name ?? 'Project'}
          selectedNodeId={selectedNodeId}
          selectedNodeIds={selectedNodeIds}
          selectedColumns={selectedColumns}
        />
      </div>
      <WickyPane projectId={id} graph={graph ?? null} selectedNodeId={selectedNodeId} />
      <RefactorHost projectId={id} />
      <ScheduleFailureToast projectId={id} />
        {paletteOpen && (
          <CommandPalette
            projectId={id}
            graph={graph ?? null}
            query={paletteQuery}
            onQueryChange={setPaletteQuery}
            onClose={closePalette}
          />
        )}
      </div>
      </SelectedColumnsContext.Provider>
      </SetSelectedColumnsContext.Provider>
      </SelectedNodeIdsContext.Provider>
      </SetSelectedNodeIdsContext.Provider>
      </SelectedNodeContext.Provider>
      </SetSelectedNodeContext.Provider>
    </CommandPaletteContext.Provider>
  );
}
