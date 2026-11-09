import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useProjectEvents } from '../../../../lib/sse';

/** Build changed previews are kept (reopening the dialog shows the last one) until something
 *  they depend on changes: files, git (commits, branch switches) or the manifest. */
export const STATE_PREVIEW_STALE_EVENTS = new Set(['files_changed', 'git_status_changed', 'graph_changed']);

/** Mounted in ProjectLayout, so previews go stale even while the Impact tab is closed. */
export function useStatePreviewCache(projectId: number) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event) => {
    if (STATE_PREVIEW_STALE_EVENTS.has(event.type)) qc.removeQueries({ queryKey: ['state-preview', projectId] });
  }, [projectId, qc]));
}
