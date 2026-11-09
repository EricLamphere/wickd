import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { api } from '../../../../lib/api';
import { alertError } from '../../../../lib/dialogs';
import { slimApi } from '../../../../lib/slimApi';
import { apiErrorMessage } from '../../../../lib/slimBuild';
import { useProjectEvents } from '../../../../lib/sse';

const LATEST = { limit: 1 };

/** Execution DAG header: `dbt retry` once the project's last run failed. */
export function RetryLastRunButton({ projectId, disabled }: { projectId: number; disabled: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({
    queryKey: ['run-history', projectId, LATEST],
    queryFn: () => api.runHistory.list(projectId, LATEST),
  });
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'run_history_changed' || event.type === 'run_started') {
      qc.invalidateQueries({ queryKey: ['run-history', projectId, LATEST] });
    }
  }, [projectId, qc]));

  const latest = data?.items[0];
  if (!latest?.retryable) return null;
  const retry = async () => {
    setBusy(true);
    try {
      await slimApi.retry(projectId, latest.id);
    } catch (err) {
      alertError(new Error(apiErrorMessage(err, 'Retry failed')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={retry}
      disabled={disabled || busy}
      title="dbt retry: re-run only the nodes that failed or were skipped in the last run"
      className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold tracking-wide border border-red-700 text-red-300 transition-colors hover:bg-red-900/40 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Undo2 size={12} />
      Retry failed
    </button>
  );
}
