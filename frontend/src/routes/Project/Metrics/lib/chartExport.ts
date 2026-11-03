// A metric chart's exports from its ⋯ menu: the rows as CSV, the file name, and which query's
// SQL "Open in Workspace" takes. Pure; tested in chartExport.test.ts. (The PNG is drawn from
// the DOM by lib/dashboardExport's capture, like dashboards.)
import type { WidgetQueryDto, WidgetResultDto } from '../../../../lib/dashboardsApi';
import type { MetricQueryBody } from '../../../../lib/semanticApi';
import { toCsv } from '../dashboards/dashboardModel';

/** Roles in the order a chart's "own" query is looked for (the comparison's come last). */
const MAIN_ROLES = ['current', 'total', 'trend'];

/** The query a chart's CSV and SQL come from: its current-period one, else the first that ran. */
export function chartQuery(result: WidgetResultDto | null | undefined): WidgetQueryDto | null {
  if (!result) return null;
  for (const role of MAIN_ROLES) {
    const q = result.queries[role];
    if (q?.status === 'ok') return q;
  }
  return Object.values(result.queries).find((q) => q.status === 'ok') ?? null;
}

export function chartCsv(result: WidgetResultDto | null | undefined): string | null {
  const q = chartQuery(result);
  return q ? toCsv(q.columns, q.rows) : null;
}

/** `revenue-over-time-20261102` (no extension: the export adds it). */
export function chartFileName(parts: string[], date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const slug = parts.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'chart';
  return `${slug}-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

/** A saved query's suggested name: `revenue_by_week`, `revenue_orders_by_country` (lowercase, digits, underscores). */
export function savedQueryName(body: MetricQueryBody): string {
  const short = (g: string) => (g.startsWith('metric_time__') ? g.slice('metric_time__'.length) : g.split('__').pop() ?? g);
  const by = (body.group_by ?? []).map(short);
  const raw = `${(body.metrics ?? []).join('_')}${by.length ? `_by_${by.join('_')}` : ''}`;
  return raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'saved_query';
}
