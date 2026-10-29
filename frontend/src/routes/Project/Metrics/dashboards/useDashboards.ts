// Data for the Dashboards tab: ['dashboards', id] (the folder), ['dashboard', id, slug] (one
// file), ['dashboard-results', id, slug] (cached widget results; never runs anything).
// `dashboards_changed` (watcher or our own writes) refetches the files; `graph_changed`
// (definitions changed → new SQL) and target switches refetch the results.
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardsApi, type DashboardDetailDto, type DashboardDoc, type DashboardResultsDto } from '../../../../lib/dashboardsApi';
import { signatures } from './dashboardModel';
import { semanticErrorBody } from '../../../../lib/semanticApi';
import { useProjectEvents } from '../../../../lib/sse';

export function errorText(err: unknown): string | null {
  if (!err) return null;
  return semanticErrorBody(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

function useDashboardEvents(projectId: number) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'dashboards_changed') {
      qc.invalidateQueries({ queryKey: ['dashboards', projectId] });
      const slug = (event.data as { slug?: string } | undefined)?.slug;
      qc.invalidateQueries({ queryKey: slug ? ['dashboard', projectId, slug] : ['dashboard', projectId] });
      qc.invalidateQueries({ queryKey: slug ? ['dashboard-results', projectId, slug] : ['dashboard-results', projectId] });
    }
    if (event.type === 'graph_changed') {
      // definitions changed (new SQL), and a linked exposure may have appeared or gone
      qc.invalidateQueries({ queryKey: ['dashboard-results', projectId] });
      qc.invalidateQueries({ queryKey: ['dashboard', projectId] });
      qc.invalidateQueries({ queryKey: ['dashboards', projectId] });
    }
  }, [projectId, qc]));
}

export function useDashboardList(projectId: number) {
  useDashboardEvents(projectId);
  return useQuery({ queryKey: ['dashboards', projectId], queryFn: () => dashboardsApi.list(projectId), retry: false });
}

export function useDashboard(projectId: number, slug: string | null) {
  useDashboardEvents(projectId);
  return useQuery({
    queryKey: ['dashboard', projectId, slug],
    queryFn: () => dashboardsApi.get(projectId, slug as string),
    enabled: !!slug,
    retry: false,
  });
}

/** Results plus, per widget, the settings they were computed for (dashboardModel querySignature). */
export type StampedResults = DashboardResultsDto & { signatures: Record<string, string> };

/**
 * Cached results on open; `refresh()` runs widgets (all, or some) in one batch. `snapshot()`
 * returns the dashboard as saved when a request starts, so each widget's results carry the
 * settings they were computed for and the builder can tell when they're out of date.
 */
export function useDashboardResults(projectId: number, slug: string | null, enabled: boolean, snapshot: () => DashboardDoc | null) {
  const qc = useQueryClient();
  const key = ['dashboard-results', projectId, slug];
  const results = useQuery({
    queryKey: key,
    queryFn: async (): Promise<StampedResults> => {
      const doc = snapshot();
      const data = await dashboardsApi.results(projectId, slug as string);
      return { ...data, signatures: signatures(doc) };
    },
    enabled: !!slug && enabled,
    retry: false,
    staleTime: 0,
    placeholderData: (prev) => prev,
  });
  const refresh = useMutation({
    mutationFn: async (widgetIds?: string[]): Promise<StampedResults> => {
      const doc = snapshot();
      const data = await dashboardsApi.refresh(projectId, slug as string, widgetIds);
      return { ...data, signatures: signatures(doc, widgetIds) };
    },
    onSuccess: (data: StampedResults, widgetIds) => {
      qc.setQueryData<StampedResults>(key, (prev) => {
        if (!widgetIds || !prev) return data;
        const fresh = new Map(data.widgets.map((w) => [w.widget_id, w]));
        return { ...data, widgets: prev.widgets.map((w) => fresh.get(w.widget_id) ?? w),
          signatures: { ...prev.signatures, ...data.signatures } };
      });
    },
  });
  return { results, refresh };
}

/** Save the file; the cache takes the server's copy (with its new modified_at). */
export function useSaveDashboard(projectId: number, slug: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ doc, base }: { doc: DashboardDoc; base: string | null }) =>
      dashboardsApi.save(projectId, slug as string, doc, base),
    onSuccess: (saved: DashboardDetailDto) => {
      qc.setQueryData(['dashboard', projectId, slug], saved);
      qc.invalidateQueries({ queryKey: ['dashboards', projectId] });
    },
  });
}
