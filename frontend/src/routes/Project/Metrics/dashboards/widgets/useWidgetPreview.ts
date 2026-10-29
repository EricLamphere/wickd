// A draft widget's result: Drill into…'s drafts (POST …/dashboards/{slug}/preview, planned with
// the dashboard's period and filters) and the metric explorer's widget (POST
// …/semantic/widget/preview, its own period), both run when nothing is stored. Their own keys
// (['dashboard-preview', id, slug, …], ['explore-widget', id, …]): never under
// 'dashboard-results', which `graph_changed` invalidates — every `dbt show` rewrites
// manifest.json, so a refetch on it would run again while other drafts were still running,
// whose runs rewrite the manifest again: a loop. Only `dashboards_changed` (a new period or
// filters) refetches the drafts (useDashboards.ts). Edits that don't change the queries (title,
// format) don't refetch; others wait a moment so typing in a field doesn't run a query per key.
import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardsApi, type DashboardWidget, type WidgetResultDto } from '../../../../../lib/dashboardsApi';

const SETTLE_MS = 400;
const DISPLAY_OPTIONS = new Set(['format', 'decimals', 'currency', 'higher_is_better']);

/** What a widget's queries depend on (title, size and display options aside, they're the same). */
function querySide(widget: DashboardWidget): string {
  const options = Object.fromEntries(Object.entries(widget.options ?? {}).filter(([k]) => !DISPLAY_OPTIONS.has(k)));
  return JSON.stringify({ type: widget.type, metrics: widget.metrics, filters: widget.filters, period: widget.period, options });
}

/** `widget` once its query side has stopped changing for a moment (immediately the first time). */
function useSettled(widget: DashboardWidget | null): { key: string | null; widget: DashboardWidget | null } {
  const key = widget ? querySide(widget) : null;
  const [settled, setSettled] = useState<{ key: string | null; widget: DashboardWidget | null }>({ key, widget });
  useEffect(() => {
    if (key === settled.key) return;
    const t = setTimeout(() => setSettled({ key, widget }), settled.key === null ? 0 : SETTLE_MS);
    return () => clearTimeout(t);
  }, [key, widget, settled.key]);
  return settled;
}

export function useWidgetPreview(projectId: number, slug: string, widget: DashboardWidget | null) {
  const settled = useSettled(widget);
  return useQuery({
    queryKey: ['dashboard-preview', projectId, slug, settled.key],
    queryFn: async () => (await dashboardsApi.preview(projectId, slug, [settled.widget!])).widgets[0],
    enabled: !!settled.widget,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  });
}

/** The explorer's widget; `refresh()` runs it on the warehouse even when a result is stored. */
export function useExplorePreview(projectId: number, widget: DashboardWidget) {
  const qc = useQueryClient();
  const settled = useSettled(widget);
  const queryKey = ['explore-widget', projectId, settled.key];
  const query = useQuery({
    queryKey,
    queryFn: async () => (await dashboardsApi.previewExplore(projectId, settled.widget!)).widget,
    enabled: !!settled.widget?.metrics?.length,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  });
  const refresh = useMutation({
    mutationFn: async () => (await dashboardsApi.previewExplore(projectId, settled.widget!, { refresh: true })).widget,
    onSuccess: (result: WidgetResultDto) => qc.setQueryData(queryKey, result),
  });
  return { ...query, refresh: refresh.mutate, refreshing: refresh.isPending, refreshError: refresh.error };
}
