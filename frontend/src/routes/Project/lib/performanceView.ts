/**
 * Pure helpers for the Run History "Performance" tab: table rows (DataTable
 * cells are plain values, so trends are text sparklines) and labels.
 */
import type { RecommendationDto, RegressionDto, SlowNodeDto } from '../../../lib/api';
import { formatSeconds } from './runTimeline';

const SPARK = '▁▂▃▄▅▆▇█';

/** Unicode block sparkline scaled to the series' own min..max. */
export function textSparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v) => SPARK[span === 0 ? 3 : Math.round(((v - min) / span) * (SPARK.length - 1))])
    .join('');
}

export const SLOWEST_COLUMNS = [
  { key: 'Node' },
  { key: 'Type' },
  { key: 'Median', align: 'right' as const },
  { key: 'Last', align: 'right' as const },
  { key: 'Runs', align: 'right' as const },
  { key: 'Trend' },
];

export function slowestRows(nodes: SlowNodeDto[]): unknown[][] {
  return nodes.map((n) => [
    n.name,
    n.resource_type,
    formatSeconds(n.median_s),
    formatSeconds(n.last_s),
    n.runs,
    textSparkline(n.recent),
  ]);
}

export const REGRESSION_COLUMNS = [
  { key: 'Node' },
  { key: 'Now', align: 'right' as const },
  { key: 'Usual (median)', align: 'right' as const },
  { key: 'Slower by', align: 'right' as const },
  { key: 'Runs compared', align: 'right' as const },
];

export function regressionRows(regressions: RegressionDto[]): unknown[][] {
  return regressions.map((r) => [
    r.name,
    formatSeconds(r.current),
    formatSeconds(r.baseline_median),
    `+${formatSeconds(r.current - r.baseline_median)} (${Math.round((r.ratio - 1) * 100)}%)`,
    r.runs_considered,
  ]);
}

export function savingLabel(rec: RecommendationDto): string | null {
  return rec.estimated_saving_s ? `saves up to ~${formatSeconds(rec.estimated_saving_s)}` : null;
}

/** The question sent to Wicky from a "make incremental" recommendation. */
export function incrementalDraftQuestion(rec: RecommendationDto): string {
  const name = rec.name ?? rec.unique_id ?? 'this model';
  const hint = rec.evidence.find((e) => e.includes('natural incremental filter'));
  return (
    `Draft an incremental version of the ${name} model: choose a unique_key and an ` +
    `is_incremental() filter${hint ? ` (${hint.replace(/`/g, '')})` : ''}, and explain any risks.`
  );
}
