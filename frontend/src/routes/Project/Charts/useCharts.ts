// Queries for the Charts page and nav: ['charts', id] (boards + build state, cheap: no dct) and
// ['charts-validate', id] (`dct validate`, a few seconds), both invalidated by SSE events —
// charts_changed (board files on disk), charts_build_started / charts_build_finished.
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { chartsApi, type ChartsEnvEvent } from '../../../lib/chartsApi';
import { useGlobalEvents, useProjectEvents } from '../../../lib/sse';

type SseEvent = { type: string; data: unknown };

export function useChartBoards(projectId: number) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event: SseEvent) => {
    if (event.type === 'charts_changed' || event.type === 'charts_build_started' || event.type === 'charts_build_finished') {
      qc.invalidateQueries({ queryKey: ['charts', projectId] });
    }
    if (event.type === 'charts_changed') qc.invalidateQueries({ queryKey: ['charts-validate', projectId] });
  }, [projectId, qc]));
  return useQuery({ queryKey: ['charts', projectId], queryFn: () => chartsApi.list(projectId), staleTime: 30_000 });
}

export function useChartsValidation(projectId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['charts-validate', projectId],
    queryFn: () => chartsApi.validate(projectId),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/** The sidecar install progress (`charts_env`), null when nothing is installing. */
export function useChartsEnv(): ChartsEnvEvent | null {
  const qc = useQueryClient();
  const [state, setState] = useState<ChartsEnvEvent | null>(null);
  useGlobalEvents(useCallback((event: SseEvent) => {
    if (event.type !== 'charts_env') return;
    const data = event.data as ChartsEnvEvent;
    setState(data.state === 'installing' ? data : null);
    if (data.state !== 'installing') qc.invalidateQueries({ queryKey: ['charts'] });
  }, [qc]));
  return state;
}
