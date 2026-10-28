// Metric monitors (Pro): the list (['metric-monitors', id]), one monitor's series (same
// prefix, so one invalidation refreshes both) and the actions. Refreshed by the
// metric_monitor_* events — never polled.
import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, isProFeatureRequiredError } from '../../../../lib/api';
import { monitorsApi, type MonitorCreateBody, type MonitorListDto, type MonitorPatchBody } from '../../../../lib/monitorsApi';
import { useProjectEvents } from '../../../../lib/sse';
import { useProEntitled } from '../../RunHistory/usePerformance';
import { statusesByMetric, type MetricMonitorState } from './monitorView';

const STALE_EVENTS = new Set(['metric_monitor_started', 'metric_monitor_finished']);

const noRetryWhenSettled = (count: number, err: unknown) =>
  !isProFeatureRequiredError(err) && !(err instanceof ApiError && err.status === 503) && count < 2;

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: unknown } | string | null;
    if (typeof body === 'string') return body;
    if (body && typeof body.message === 'string' && body.message) return body.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The project's monitors; `step` follows a running refresh (slices → querying → detecting). */
export function useMonitors(projectId: number, enabled = true) {
  const qc = useQueryClient();
  const { entitled, loading } = useProEntitled();
  const [step, setStep] = useState<string | null>(null);

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'metric_monitor_progress') setStep((event.data as { step?: string }).step ?? null);
    if (event.type === 'metric_monitor_started') setStep('starting');
    if (event.type === 'metric_monitor_finished') setStep(null);
    if (STALE_EVENTS.has(event.type)) qc.invalidateQueries({ queryKey: ['metric-monitors', projectId] });
  }, [projectId, qc]));

  const query = useQuery({
    queryKey: ['metric-monitors', projectId],
    queryFn: () => monitorsApi.list(projectId),
    enabled: enabled && entitled,
    retry: noRetryWhenSettled,
  });

  return {
    data: query.data ?? null,
    loading: loading || (entitled && enabled && query.isLoading),
    locked: (!loading && !entitled) || isProFeatureRequiredError(query.error),
    unavailable: query.error instanceof ApiError && query.error.status === 503,
    error: query.error,
    running: !!query.data?.running || step !== null,
    step,
  };
}

/** Worst status per monitored metric (empty without Pro); for DAG dots and Impact flags. */
export function useMonitorStatuses(projectId: number): Map<string, MetricMonitorState> {
  const { data } = useMonitors(projectId);
  return useMemo(() => statusesByMetric(data?.monitors ?? []), [data]);
}

export function useMonitorSeries(projectId: number, monitorId: number | null, slice: string) {
  return useQuery({
    queryKey: ['metric-monitors', projectId, 'series', monitorId, slice],
    queryFn: () => monitorsApi.series(projectId, monitorId!, slice),
    enabled: monitorId !== null,
    retry: noRetryWhenSettled,
  });
}

/** Create / update / delete / refresh / interval / mark as expected; the list refetches after each. */
export function useMonitorActions(projectId: number) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(call: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await call();
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['metric-monitors', projectId] });
    }
  }, [projectId, qc]);

  return {
    busy,
    error,
    clearError: () => setError(null),
    create: (body: MonitorCreateBody) => run(() => monitorsApi.create(projectId, body)),
    update: (id: number, body: MonitorPatchBody) => run(() => monitorsApi.update(projectId, id, body)),
    remove: (id: number) => run(() => monitorsApi.remove(projectId, id)),
    refresh: (ids?: number[]) => run(() => monitorsApi.refresh(projectId, ids)),
    /** Drag-to-reorder: shown at once (optimistic), then saved; the list refetches either way. */
    reorder: (ids: number[]) => {
      qc.setQueryData<MonitorListDto>(['metric-monitors', projectId], (old) => {
        if (!old) return old;
        const byId = new Map(old.monitors.map((m) => [m.id, m]));
        const ordered = ids.flatMap((id, position) => {
          const m = byId.get(id);
          return m ? [{ ...m, position }] : [];
        });
        return { ...old, monitors: [...ordered, ...old.monitors.filter((m) => !ids.includes(m.id))] };
      });
      return run(() => monitorsApi.reorder(projectId, ids));
    },
    setInterval: (hours: number | null) => run(() => monitorsApi.setInterval(projectId, hours)),
    suppress: (id: number, slice: string, period: string, suppressed: boolean) =>
      run(() => monitorsApi.suppress(projectId, id, { slice, period, suppressed })),
  };
}
