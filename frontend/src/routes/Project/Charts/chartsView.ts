// Pure helpers for the Charts page (dbt Charts boards, plan 17); unit-tested in chartsView.test.ts.
import type { BoardBuild, BoardValidation, ChartBoard, ChartsDiagnostic } from '../../../lib/chartsApi';

export const VIEW_MODES = ['static', 'live'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** The board to show: the one asked for, else the remembered one, else the first that parses. */
export function pickBoard(boards: readonly ChartBoard[], requested: string | null, remembered: string | null): string | null {
  const ids = new Set(boards.map((b) => b.id));
  if (requested && ids.has(requested)) return requested;
  if (remembered && ids.has(remembered)) return remembered;
  return (boards.find((b) => !b.error) ?? boards[0])?.id ?? null;
}

/** `http://127.0.0.1:5123` + `team/ops` → `http://127.0.0.1:5123/team/ops/` (dct serves boards as folders). */
export function liveBoardUrl(baseUrl: string, urlPath: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  const path = urlPath.replace(/^\/+|\/+$/g, '');
  return path ? `${root}/${path}/` : `${root}/`;
}

/** Validation issues first (errors, then warnings), then the last build's — deduplicated by code + message. */
export function boardIssues(validation: BoardValidation | undefined, build: BoardBuild | null): ChartsDiagnostic[] {
  const all = [...(validation?.errors ?? []), ...(build?.diagnostics ?? []).filter((d) => d.level === 'error'),
    ...(validation?.warnings ?? []), ...(build?.diagnostics ?? []).filter((d) => d.level !== 'error')];
  const seen = new Set<string>();
  return all.filter((d) => {
    const key = `${d.code}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function issueCounts(issues: readonly ChartsDiagnostic[]): { errors: number; warnings: number } {
  const errors = issues.filter((d) => d.level === 'error').length;
  return { errors, warnings: issues.length - errors };
}

export function elapsedLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "Built 3 min ago on dev in 2.9 s" */
export function buildLabel(build: BoardBuild, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(build.built_at).getTime()) / 1000));
  const ago = seconds < 60 ? 'just now'
    : seconds < 3600 ? `${Math.round(seconds / 60)} min ago`
      : seconds < 86400 ? `${Math.round(seconds / 3600)} h ago`
        : new Date(build.built_at).toLocaleDateString();
  const target = build.target ? ` on ${build.target}` : '';
  return `${build.ok ? 'Built' : 'Build failed'} ${ago}${target} in ${elapsedLabel(build.elapsed_ms)}`;
}

/** Group boards by their folder under charts/ ("" first), keeping the API's path order inside each. */
export function groupByFolder(boards: readonly ChartBoard[]): Array<{ folder: string; boards: ChartBoard[] }> {
  const groups = new Map<string, ChartBoard[]>();
  for (const b of boards) {
    const cut = b.id.lastIndexOf('/');
    const folder = cut < 0 ? '' : b.id.slice(0, cut);
    groups.set(folder, [...(groups.get(folder) ?? []), b]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, list]) => ({ folder, boards: list }));
}
