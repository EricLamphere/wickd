// "Explore" / "Metric page" entry points into the Metrics page (SidePane, Docs) and the Docs
// preview sparkline.
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileBarChart, LineChart } from 'lucide-react';
import { Sparkline } from '../../../components/charts/Sparkline';
import { semanticApi } from '../../../lib/semanticApi';
import { relativeTime } from '../lib/relativeTime';
import { exploreSearch, exploreUrl, metricPageUrl, previewBody } from './lib/exploreLink';
import { formatTime, formatValue, parseTime, toNumber } from './lib/metricSeries';

interface ExploreProps {
  projectId: number;
  resourceType: string;
  name: string;
  /** The metric's default grain (semantic.time_granularity) */
  grain?: string | null;
  /** semantic_model: the metrics defined on it */
  modelMetrics?: string[];
}

export function ExploreButton({ projectId, resourceType, name, grain, modelMetrics }: ExploreProps) {
  const navigate = useNavigate();
  const search = exploreSearch(resourceType, name, { grain, modelMetrics });
  if (!search) return null;
  const cls = 'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:border-brand-600 hover:text-brand-300 transition-colors';
  return (
    <div className="flex flex-wrap items-center gap-2 self-start">
      {resourceType === 'metric' && (
        <button onClick={() => navigate(metricPageUrl(projectId, name))} title="Its definition, chart, lineage, usage and health" className={cls}>
          <FileBarChart className="w-3.5 h-3.5" />Metric page
        </button>
      )}
      <button
        onClick={() => navigate(exploreUrl(projectId, search))}
        title={resourceType === 'saved_query' ? 'Run this saved query on the Metrics page' : 'Query it on the Metrics page'}
        className={cls}
      >
        <LineChart className="w-3.5 h-3.5" />Explore
      </button>
    </div>
  );
}

/** The metric's last stored result over metric_time (what Explore opens), as a sparkline. Never runs a query. */
export function MetricPreview({ projectId, metric, grain }: { projectId: number; metric: string; grain?: string | null }) {
  const body = previewBody(metric, grain);
  const { data } = useQuery({
    queryKey: ['metric-result', projectId, JSON.stringify(body)],
    queryFn: () => semanticApi.cachedQuery(projectId, body),
    retry: false,
  });
  if (!data || data.rows.length < 2) return null;
  const time = data.columns.indexOf(body.group_by?.[0] ?? '');
  const value = data.columns.indexOf(metric);
  const points = data.rows
    .map((r) => ({ t: parseTime(r[time]), v: toNumber(r[value]) }))
    .filter((p): p is { t: number; v: number } => p.t != null && p.v != null)
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) return null;
  const g = grain || 'day';
  return (
    <div className="flex items-center gap-3 text-[11px] text-gray-500">
      <Sparkline values={points.map((p) => p.v)} labels={points.map((p) => formatTime(p.t, g))} format={(v) => formatValue(v)} width={180} />
      <span>by {g} · last run {relativeTime(data.ran_at)}{data.target ? ` on ${data.target}` : ''}</span>
    </div>
  );
}
