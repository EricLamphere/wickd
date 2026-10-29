// A draft widget's result (Drill into…): planned with the dashboard's period and filters and run
// when nothing is stored (POST …/preview). Its own key, ['dashboard-preview', id, slug, …]: never
// under 'dashboard-results', which `graph_changed` invalidates — every `dbt show` rewrites
// manifest.json, so a refetch on it would run again while other drafts were still running, whose
// runs rewrite the manifest again: a loop. Only `dashboards_changed` (a new period or filters)
// refetches it (useDashboards.ts). Edits that don't change its queries (title, format) don't
// refetch; others wait a moment so typing in a field doesn't run a query per key.
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { dashboardsApi, type DashboardWidget } from '../../../../../lib/dashboardsApi';

const SETTLE_MS = 400;
const DISPLAY_OPTIONS = new Set(['format', 'decimals', 'currency', 'higher_is_better']);

/** What a widget's queries depend on (title, size and display options aside, they're the same). */
function querySide(widget: DashboardWidget): string {
  const options = Object.fromEntries(Object.entries(widget.options ?? {}).filter(([k]) => !DISPLAY_OPTIONS.has(k)));
  return JSON.stringify({ type: widget.type, metrics: widget.metrics, filters: widget.filters, period: widget.period, options });
}

export function useWidgetPreview(projectId: number, slug: string, widget: DashboardWidget | null) {
  const key = widget ? querySide(widget) : null;
  const [settled, setSettled] = useState<{ key: string | null; widget: DashboardWidget | null }>({ key, widget });
  useEffect(() => {
    if (key === settled.key) return;
    const t = setTimeout(() => setSettled({ key, widget }), settled.key === null ? 0 : SETTLE_MS);
    return () => clearTimeout(t);
  }, [key, widget, settled.key]);
  return useQuery({
    queryKey: ['dashboard-preview', projectId, slug, settled.key],
    queryFn: async () => (await dashboardsApi.preview(projectId, slug, [settled.widget!])).widgets[0],
    enabled: !!settled.widget,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  });
}
