import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api';
import { alertError } from '../../../../lib/dialogs';
import { useProjectEvents } from '../../../../lib/sse';
import { LogView } from './LogView';

interface LogPanelProps {
  projectId: number;
  logType: 'project' | 'api';
}

// Events that trigger a full re-fetch (run ended, pipeline done, etc.)
const PROJECT_REFETCH_EVENTS = new Set([
  'run_finished',
  'init_pipeline_finished',
  'compile_finished',
  'docs_generated',
]);

const API_REFETCH_EVENTS = new Set([
  'run_started',
  'run_finished',
  'init_pipeline_started',
  'init_pipeline_finished',
  'compile_started',
  'compile_finished',
  'docs_generating',
  'docs_generated',
]);

/** A project's Project Logs / API Logs tab. */
export function LogPanel({ projectId, logType }: LogPanelProps) {
  const qc = useQueryClient();
  const queryKey = ['logs', logType, projectId];
  // Extra lines accumulated in real time from SSE (flushed on refetch)
  const [liveLines, setLiveLines] = useState<string[]>([]);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => (logType === 'project' ? api.logs.projectLogs(projectId) : api.logs.apiLogs(projectId)),
    refetchInterval: false,
    staleTime: 0,
  });

  // Clear live lines whenever a fresh fetch completes (they'll be in `data` now)
  useEffect(() => {
    if (data) setLiveLines([]);
  }, [data]);

  const refetchEvents = logType === 'project' ? PROJECT_REFETCH_EVENTS : API_REFETCH_EVENTS;

  useProjectEvents(projectId, useCallback((event) => {
    // Real-time lines: project_log from append_project_log, api_log from every HTTP request
    if (event.type === (logType === 'project' ? 'project_log' : 'api_log')) {
      const line = (event.data as { line: string }).line;
      setLiveLines((prev) => [...prev, line]);
      return;
    }
    // On completion events, do a full refetch to get the authoritative log
    if (refetchEvents.has(event.type)) {
      setTimeout(() => {
        qc.invalidateQueries({ queryKey });
      }, 300);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logType, projectId, qc]));

  const handleClear = async () => {
    try {
      await (logType === 'project' ? api.logs.clearProjectLogs(projectId) : api.logs.clearApiLogs(projectId));
    } catch (err) {
      alertError(err);
      return;
    }
    setLiveLines([]);
    qc.invalidateQueries({ queryKey });
  };

  return (
    <LogView
      pathLabel={logType === 'project' ? 'logs/wickd/project_logs.log' : '{data_dir}/logs/wickd/api_logs.log'}
      lines={[...(data?.lines ?? []), ...liveLines]}
      isLoading={isLoading}
      onClear={handleClear}
      onRefresh={() => qc.invalidateQueries({ queryKey })}
    />
  );
}
