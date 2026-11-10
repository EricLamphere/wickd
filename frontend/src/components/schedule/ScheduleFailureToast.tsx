// A toast when a scheduled run fails while the app is focused (plan 27). Mounted in
// ProjectLayout so it shows on every project page; the Runs nav dot covers the rest.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { FAILED_OUTCOMES } from '../../lib/scheduleAlerts';
import type { ScheduleOutcome } from '../../lib/schedulesApi';
import { useProjectEvents } from '../../lib/sse';

const TOAST_MS = 10_000;
const MESSAGES: Partial<Record<ScheduleOutcome, string>> = {
  error: 'failed',
  invalid: 'couldn’t start: its command is invalid',
  skipped_busy: 'was skipped: another dbt command was running',
};

interface Failure {
  name: string;
  outcome: ScheduleOutcome;
}

export function ScheduleFailureToast({ projectId }: { projectId: number }) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const navigate = useNavigate();

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type !== 'run_schedules_changed') return;
    const data = event.data as { outcome?: ScheduleOutcome; name?: string } | undefined;
    if (!data?.outcome || !data.name || !FAILED_OUTCOMES.has(data.outcome)) return;
    if (typeof document !== 'undefined' && !document.hasFocus()) return;
    setFailure({ name: data.name, outcome: data.outcome });
  }, []));

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [failure]);

  if (!failure) return null;
  return (
    <div role="status"
      className="fixed top-14 right-4 z-40 flex items-start gap-2 w-80 max-w-[calc(100vw-2rem)] px-3 py-2.5 rounded-lg border border-red-900/60 bg-surface-panel shadow-xl text-xs text-gray-300">
      <AlertTriangle className="w-4 h-4 mt-px text-red-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p>Scheduled run <span className="font-medium text-gray-100">{failure.name}</span> {MESSAGES[failure.outcome] ?? failure.outcome}.</p>
        <button onClick={() => { setFailure(null); navigate(`/projects/${projectId}/runs?tab=schedule`); }}
          className="mt-1 text-brand-400 hover:text-brand-300">View schedule</button>
      </div>
      <button onClick={() => setFailure(null)} aria-label="Dismiss" className="text-gray-500 hover:text-gray-200"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}
