/** Pure helpers for the Run History "Performance" tab (tables in RunHistory/PerformanceTables.tsx). */
import type { RecommendationDto } from '../../../lib/api';
import { formatSeconds } from './runTimeline';

export type ChangeTone = 'slower' | 'faster' | 'same';

/** formatSeconds(), but milliseconds under a second (fast adapters finish most nodes in ms). */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0ms';
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`;
  return formatSeconds(seconds);
}

/** How `now` compares with `usual`: "+20s" / "+200%", within 10% (or 1s) counts as the same. */
export function changeVsUsual(now: number, usual: number): { delta: string; pct: string; tone: ChangeTone } {
  const diff = now - usual;
  const ratio = usual > 0 ? diff / usual : 0;
  const tone: ChangeTone = Math.abs(ratio) < 0.1 || Math.abs(diff) < 1 ? 'same' : diff > 0 ? 'slower' : 'faster';
  const sign = diff >= 0 ? '+' : '−';
  return {
    delta: `${sign}${formatDuration(Math.abs(diff))}`,
    pct: usual > 0 ? `${sign}${Math.round(Math.abs(ratio) * 100)}%` : '',
    tone,
  };
}

/** Rows whose name contains `query` (case-insensitive); all rows for an empty query. */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}

/** Resource types present, most common first (for filter chips). */
export function typeCounts(rows: { resource_type: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.resource_type, (counts.get(r.resource_type) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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
