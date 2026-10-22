import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DriftSnapshot } from '../../../lib/api';
import { useProjectEvents } from '../../../lib/sse';
import { useOpenInFiles } from '../lib/openInFiles';
import { driftProgressLabel, type DriftProgress } from '../lib/driftProgress';
import { relativeTime } from '../lib/relativeTime';
import DriftResults from './drift/DriftResults';
import { categorize, skippedLabel } from './drift/driftView';
import RunButton from './health/RunButton';
import Spinner from './health/Spinner';
import StaleNotice from './health/StaleNotice';
import { errorMessage, useHealthRuns, useHealthSummary, useIsStarting } from './health/useHealth';

interface DriftPanelProps {
  projectId: number;
}

export default function DriftPanel({ projectId }: DriftPanelProps) {
  const qc = useQueryClient();
  const fileNav = useOpenInFiles(projectId);
  const [liveProgress, setLiveProgress] = useState<DriftProgress | null>(null);

  const { data: snapshot, isLoading } = useQuery({
    queryKey: ['drift-latest', projectId],
    queryFn: () => api.drift.latest(projectId),
    retry: false,
  });
  const { drift: run } = useHealthRuns(projectId);
  const { data: summary } = useHealthSummary(projectId);

  // Started here or from the overview's Run / Run all
  const isRunning = useIsStarting('drift', projectId) || snapshot?.status === 'running';

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'drift_started') {
      // Reset on the scan's own first event, whoever started it (clearing when the
      // POST resolves would race the first drift_progress, which can arrive earlier)
      setLiveProgress(null);
      qc.invalidateQueries({ queryKey: ['drift-latest', projectId] });
    }
    if (event.type === 'drift_progress') {
      const d = event.data as DriftProgress;
      setLiveProgress(d);
      qc.setQueryData<DriftSnapshot | null>(['drift-latest', projectId], (old) => {
        if (!old) return old;
        return { ...old, checked_models: d.checked, total_models: d.total };
      });
    }
    if (event.type === 'drift_finished') {
      setLiveProgress(null);
      qc.invalidateQueries({ queryKey: ['drift-latest', projectId] });
    }
  }, [projectId, qc]));

  const progress = liveProgress ?? (snapshot ? { checked: snapshot.checked_models, total: snapshot.total_models, current: '' } : null);
  const done = !isRunning && snapshot && snapshot.status === 'done';
  const groups = categorize(snapshot?.results ?? []);
  const issues = groups.drifted.length + groups.notBuilt.length + groups.errors.length;
  const skipped = snapshot ? skippedLabel(snapshot.skipped) : null;

  return (
    <div className="p-6 pb-12 max-w-[62rem] mx-auto w-full">
      <div className="bg-surface-panel border border-gray-800 rounded-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-800">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-semibold text-gray-100">Schema Drift</span>
            {done && (
              <span className={`text-xs ${issues > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {summary?.drift.headline ?? `${issues} of ${snapshot.total_models} with issues`}
                <span className="text-gray-600"> · {relativeTime(snapshot.finished_at ?? snapshot.started_at)}</span>
              </span>
            )}
            {done && (
              <span className="text-[11px] text-gray-600" title="Only tables, incremental models, seeds and snapshots are checked">
                {snapshot.total_models} checked{skipped ? ` · ${skipped}` : ''}
                {' · target '}<span className="font-mono text-gray-500">{snapshot.target ?? 'default'}</span>
              </span>
            )}
            {!isRunning && !snapshot && !isLoading && (
              <span className="text-xs text-gray-600">Not run yet</span>
            )}
            {isRunning && (
              <span className="text-xs text-brand-400 flex items-center gap-1.5">
                <Spinner />
                {progress ? driftProgressLabel(progress) : 'Starting…'}
              </span>
            )}
          </div>
          <RunButton running={isRunning} onClick={() => run.mutate()} />
        </div>

        {done && summary && (
          <StaleNotice reasons={summary.drift.stale_reasons} onRerun={() => run.mutate()} />
        )}
        {run.error && !isRunning && (
          <p className="px-5 py-2 border-b border-gray-800 text-xs text-red-400">
            Couldn't start the drift check: {errorMessage(run.error)}
          </p>
        )}

        {/* Progress bar */}
        {isRunning && progress && progress.total > 0 && (
          <div className="px-5 py-2 border-b border-gray-800">
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-600 transition-all duration-300"
                style={{ width: `${Math.round((progress.checked / progress.total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Results */}
        {done && (
          <div className="px-5 py-4">
            {snapshot.results.length > 0 ? (
              <DriftResults
                projectId={projectId}
                snapshotId={snapshot.id}
                results={snapshot.results}
                scanRunning={isRunning}
                fileNav={fileNav}
              />
            ) : (
              <p className="text-xs text-gray-600">
                No eligible models found (only table, incremental, seed and snapshot models are checked).
              </p>
            )}
          </div>
        )}

        {/* Error state */}
        {!isRunning && snapshot?.status === 'error' && (
          <div className="px-5 py-4">
            <p className="text-xs text-red-400">Drift check failed: {snapshot.error_message}</p>
          </div>
        )}

        {isLoading && (
          <div className="px-5 py-4">
            <p className="text-xs text-gray-600">Loading…</p>
          </div>
        )}
      </div>
    </div>
  );
}
