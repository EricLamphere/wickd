import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { alertError } from '../../lib/dialogs';
import { useGlobalEvents } from '../../lib/sse';
import { workspaceApi, type WorkspaceDocs, type WorkspaceDocsEvent } from '../../lib/workspaceApi';

const KEY = ['workspace-docs'] as const;

/** The projects, the saved combined docs selection and live generation state (global stream). */
export function useWorkspaceDocs() {
  const qc = useQueryClient();

  useGlobalEvents(useCallback((event) => {
    if (event.type !== 'workspace_docs') return;
    qc.invalidateQueries({ queryKey: KEY });
    const { project_id, state } = event.data as WorkspaceDocsEvent;
    if (state === 'done') {
      qc.invalidateQueries({ queryKey: ['docs-data', project_id] });
      qc.invalidateQueries({ queryKey: ['docs-status', project_id] });
    }
  }, [qc]));

  const query = useQuery({ queryKey: KEY, queryFn: workspaceApi.docs });

  const selectionMutation = useMutation({
    mutationFn: workspaceApi.setSelection,
    onMutate: async (selection: number[]) => {
      await qc.cancelQueries({ queryKey: KEY });
      const previous = qc.getQueryData<WorkspaceDocs>(KEY);
      if (previous) qc.setQueryData<WorkspaceDocs>(KEY, { ...previous, selection });
      return { previous };
    },
    onError: (err, _selection, context) => {
      if (context?.previous) qc.setQueryData(KEY, context.previous);
      alertError(err);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  const generateMutation = useMutation({
    mutationFn: workspaceApi.generateDocs,
    onError: alertError,
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  const projects = useMemo(() => query.data?.projects ?? [], [query.data]);
  const selection = useMemo(() => query.data?.selection ?? [], [query.data]);

  return {
    projects,
    selection,
    isLoading: query.isLoading,
    error: query.error,
    setSelection: selectionMutation.mutate,
    generate: generateMutation.mutate,
  };
}
