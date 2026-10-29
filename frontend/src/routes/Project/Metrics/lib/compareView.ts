// Metric compare mode's view (plan 14): its state in the URL (`?cmp=<mode>&cmp_base=<ref, target
// or metric>`, next to the explore widget), how each side is labelled, and the result as a
// differences table and chart data. Pure; tested in compareView.test.ts.
import type { CompareMode, CompareOptionsDto, CompareResultDto, CompareRowDto, CompareSideDto } from '../../../../lib/semanticApi';
import { formatChange } from '../dashboards/dashboardModel';
import { emptyExploreWidget, writeExploreWidget } from './exploreWidget';
import { parseTime } from './metricSeries';

export const COMPARE_MODES: CompareMode[] = ['working', 'branch', 'targets', 'metrics'];

export interface CompareState {
  mode: CompareMode;
  /** branch: the base branch; targets: the target; metrics: the other metric ('' = the default) */
  base: string;
}

export function readCompare(params: URLSearchParams): CompareState | null {
  const mode = params.get('cmp') as CompareMode | null;
  if (!mode || !COMPARE_MODES.includes(mode)) return null;
  return { mode, base: params.get('cmp_base') ?? '' };
}

export function writeCompare(prev: URLSearchParams, state: CompareState | null): URLSearchParams {
  const next = new URLSearchParams(prev);
  next.delete('cmp');
  next.delete('cmp_base');
  if (state) {
    next.set('cmp', state.mode);
    if (state.base) next.set('cmp_base', state.base);
  }
  return next;
}

export const MODE_LABELS: Record<CompareMode, string> = {
  working: 'Uncommitted changes vs HEAD',
  branch: 'This branch vs its base',
  targets: 'Two targets',
  metrics: 'Two metrics',
};

/** The request fields for a compare state (an empty base falls back to the server's default). */
export function compareFields(state: CompareState): { base_ref?: string; base_target?: string; other_metric?: string } {
  const base = state.base.trim();
  if (!base) return {};
  if (state.mode === 'branch') return { base_ref: base };
  if (state.mode === 'targets') return { base_target: base };
  if (state.mode === 'metrics') return { other_metric: base };
  return {};
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

/** "Now · dev" / "HEAD a1b2c3d · prod" / "main (merge base 1a2b3c4)" / "revenue_v2". */
export function sideLabel(result: CompareResultDto, which: 'current' | 'base', options: CompareOptionsDto | undefined,
  labels: Map<string, string> = new Map()): string {
  const name = (m: string) => labels.get(m) ?? m;
  const side: CompareSideDto = result[which];
  const target = side.target ?? result.active_target ?? options?.active_target ?? null;
  const on = target ? ` · ${target}` : '';
  if (which === 'current') {
    const metric = result.mode === 'metrics' ? `${name(result.metrics[0])} · ` : '';
    return `${metric}${result.mode === 'working' ? 'Now, uncommitted' : result.mode === 'branch' ? 'This branch' : 'Now'}${on}`;
  }
  if (result.mode === 'metrics') return `${result.other_metric ? name(result.other_metric) : 'other metric'}${on}`;
  if (result.mode === 'branch') return `${side.ref ?? 'base'} (merge base ${short(side.sha)})${on}`;
  if (result.mode === 'working') return `HEAD ${short(side.sha)}${on}`.replace('  ', ' ');
  return `Same definitions${on}`;
}

const keyText = (v: unknown) => (v === null || v === undefined ? '∅' : String(v));

/** What to call each side's numbers: the two metrics when comparing metrics, else now / before. */
export function sideNames(result: CompareResultDto, labels: Map<string, string>): { current: string; base: string } {
  if (result.mode !== 'metrics') return { current: 'now', base: 'before' };
  const name = (m: string | null | undefined) => (m ? labels.get(m) ?? m : 'other metric');
  return { current: name(result.metrics[0]), base: name(result.other_metric) };
}
const STATUS_ORDER: Record<CompareRowDto['status'], number> = { changed: 0, only_current: 1, only_base: 2, same: 3 };
const round = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** The aligned rows as a table: changed (and one-sided) rows first; key columns, then per metric now / before / Δ / Δ%. */
export function differencesTable(result: CompareResultDto, labels: Map<string, string>, onlyChanged: boolean): { columns: string[]; rows: unknown[][] } {
  const diff = result.diff;
  if (!diff) return { columns: [], rows: [] };
  const metrics = result.metrics;
  const names = sideNames(result, labels);
  // comparing metrics: each column is one metric's; otherwise one metric now and before
  const columns = [...diff.key_columns, ...metrics.flatMap((m) => {
    if (result.mode === 'metrics') return [names.current, names.base, 'Δ', 'Δ%'];
    const l = labels.get(m) ?? m;
    return [`${l} now`, `${l} before`, `${l} Δ`, `${l} Δ%`];
  }), 'status'];
  const status: Record<CompareRowDto['status'], string> = {
    same: 'same', changed: 'changed', only_current: `only ${names.current}`, only_base: `only ${names.base}`,
  };
  const rows = [...diff.rows]
    .filter((r) => !onlyChanged || r.status !== 'same')
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    .map((r) => [...r.key.map(keyText), ...metrics.flatMap((m) => {
      const v = r.values[m];
      return v ? [round(v.current), round(v.base), round(v.delta), formatChange(v.pct) ?? ''] : [null, null, null, ''];
    }), status[r.status]]);
  return { columns, rows };
}

export interface ComparePoint {
  x: string | number;
  current: number | null;
  base: number | null;
}

/**
 * One metric's two sides for a chart: over time when the first key is a time column (sorted),
 * else per key (largest current first, top `limit`).
 */
export function compareSeries(result: CompareResultDto, metric: string, limit = 15): { time: boolean; points: ComparePoint[] } {
  const diff = result.diff;
  if (!diff) return { time: false, points: [] };
  const time = diff.key_columns[0]?.startsWith('metric_time') ?? false;
  const points = diff.rows.map((r) => ({
    x: time ? parseTime(r.key[0]) ?? keyText(r.key[0]) : r.key.map(keyText).join(' · ') || 'Total',
    current: r.values[metric]?.current ?? null,
    base: r.values[metric]?.base ?? null,
  }));
  if (time) return { time, points: points.sort((a, b) => Number(a.x) - Number(b.x)) };
  return { time, points: points.sort((a, b) => Math.abs(b.current ?? b.base ?? 0) - Math.abs(a.current ?? a.base ?? 0)).slice(0, limit) };
}

/** The explorer comparing `metric` over time (Impact's "Compare numbers", a metric page's Compare). */
export function compareUrl(projectId: number, metric: string, state: CompareState): string {
  const params = writeCompare(writeExploreWidget(new URLSearchParams({ tab: 'explore' }), emptyExploreWidget([metric])), state);
  return `/projects/${projectId}/metrics?${params.toString()}`;
}
