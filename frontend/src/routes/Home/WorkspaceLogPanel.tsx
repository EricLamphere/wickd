import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { alertError } from '../../lib/dialogs';
import { useGlobalEvents } from '../../lib/sse';
import { workspaceApi, type WorkspaceDocsEvent } from '../../lib/workspaceApi';
import { LogView } from '../Project/components/BottomPane/LogView';

type Kind = 'project' | 'api';

const LIVE_EVENT: Record<Kind, string> = { project: 'workspace_log', api: 'api_log' };

const PATH_LABEL: Record<Kind, string> = {
  project: '{data_dir}/logs/wickd/workspace_logs.log',
  api: '{data_dir}/logs/wickd/api_logs.log',
};

const EMPTY_LABEL: Record<Kind, string> = {
  project: 'Combined docs generation writes each project’s init steps and docs generate output here.',
  api: 'No log entries yet.',
};

/** The home page's Project Logs (combined docs runs) or API Logs, live from the global stream. */
export function WorkspaceLogPanel({ kind }: { kind: Kind }) {
  const qc = useQueryClient();
  const queryKey = ['workspace-logs', kind];
  const [liveLines, setLiveLines] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => workspaceApi.logs(kind),
    staleTime: 0,
  });

  useEffect(() => {
    if (data) setLiveLines([]);
  }, [data]);

  useGlobalEvents(useCallback((event) => {
    if (event.type === LIVE_EVENT[kind]) {
      const line = (event.data as { line: string }).line;
      setLiveLines((prev) => [...prev, line]);
      return;
    }
    // A project's run settled: refetch the authoritative tail
    if (kind === 'project' && event.type === 'workspace_docs') {
      const { state } = event.data as WorkspaceDocsEvent;
      if (state === 'done' || state === 'error') qc.invalidateQueries({ queryKey });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, qc]));

  const handleClear = async () => {
    try {
      await workspaceApi.clearLogs(kind);
    } catch (err) {
      alertError(err);
      return;
    }
    setLiveLines([]);
    qc.invalidateQueries({ queryKey });
  };

  return (
    <LogView
      pathLabel={PATH_LABEL[kind]}
      lines={[...(data?.lines ?? []), ...liveLines]}
      isLoading={isLoading}
      emptyLabel={EMPTY_LABEL[kind]}
      onClear={handleClear}
      onRefresh={() => qc.invalidateQueries({ queryKey })}
    />
  );
}
