// Progress of the metric queries running for this project, with Cancel (stops the remaining
// queries; finished results stay). Shown in the Metrics page header (every run: Run all, metric
// pages, dashboards, monitors, compare, debug checks) and in the query view (its own runs).
// Renders nothing while nothing runs.
import { Loader2, Square } from 'lucide-react';
import { alertError } from '../../../lib/dialogs';
import { progressText, type RunKind } from './lib/queryActivity';
import { useMetricQueryActivity } from './useMetricQueryActivity';

export function MetricQueryActivity({ projectId, kinds, className = '' }: {
  projectId: number;
  /** only runs of these kinds (all when omitted) */
  kinds?: readonly RunKind[];
  className?: string;
}) {
  const { summary, cancel, cancelPending } = useMetricQueryActivity(projectId, kinds);
  if (!summary) return null;
  const stopping = summary.cancelling || cancelPending;
  const pct = summary.total > 1 ? Math.round((summary.done / summary.total) * 100) : null;
  return (
    <div role="status" aria-live="polite" className={`flex items-center gap-2 text-[11px] text-gray-400 ${className}`}>
      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
      <span className="whitespace-nowrap">{stopping ? 'Stopping…' : `Running ${progressText(summary)}`}</span>
      {pct !== null && !stopping && (
        <span className="hidden sm:block w-20 h-1 rounded bg-gray-800 overflow-hidden" aria-hidden>
          <span className="block h-full bg-brand-500 transition-[width]" style={{ width: `${pct}%` }} />
        </span>
      )}
      <button
        onClick={() => cancel(undefined, { onError: (err) => void alertError(err) })}
        disabled={stopping}
        title="Stop the queries that haven't finished; finished results are kept"
        className="flex items-center gap-1 px-2 py-0.5 rounded border border-gray-700 text-gray-300 hover:border-red-700 hover:text-red-300 disabled:opacity-40"
      >
        <Square className="w-3 h-3" />Cancel
      </button>
    </div>
  );
}
