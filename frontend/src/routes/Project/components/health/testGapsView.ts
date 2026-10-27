import type { IgnoredGapDto, TestGapCandidateDto, TestGapDto } from '../../../../lib/testGapsApi';

/** `not_null`, `relationships → dim_customers.customer_id`, `unique_combination_of_columns` */
export function describeCandidate(c: TestGapCandidateDto): string {
  if (c.test === 'relationships' && c.to) return `relationships → ${c.to.split('.').pop()}.${c.field ?? ''}`;
  return c.test;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** What depends on the column: "4 columns · 2 models filter/join · 1 exposure · grain". */
export function describeUse(row: Pick<TestGapDto, 'reach' | 'row_uses' | 'exposures' | 'in_grain'>): string {
  const parts: string[] = [];
  if (row.reach) parts.push(plural(row.reach, 'column'));
  if (row.row_uses) parts.push(`${plural(row.row_uses, 'model')} filter/join`);
  if (row.exposures) parts.push(plural(row.exposures, 'exposure'));
  if (row.in_grain) parts.push('grain');
  return parts.join(' · ') || '—';
}

export function gapSubject(row: Pick<TestGapDto, 'column' | 'columns'>): string {
  return row.column ?? `(${(row.columns ?? []).join(', ')})`;
}

export interface TestGapsCardState {
  tone: 'ok' | 'warn' | 'fail' | 'running' | 'idle';
  headline: string;
  /** offer "Refresh lineage" (no scan yet, an old one, or a failed one) */
  canRefresh: boolean;
}

/** The Health overview's Test Gaps card: locked, waiting on lineage, or the gap count. */
export function testGapsCardState(input: {
  locked: boolean;
  loading: boolean;
  notReady: 'missing' | 'running' | 'outdated' | 'error' | null;
  lineageRunning: boolean;
  total: number | null;
  failed: boolean;
}): TestGapsCardState {
  if (input.locked) return { tone: 'idle', headline: 'wickd Pro', canRefresh: false };
  if (input.lineageRunning || input.notReady === 'running') {
    return { tone: 'running', headline: 'Computing column lineage…', canRefresh: false };
  }
  if (input.notReady === 'missing') return { tone: 'idle', headline: 'Needs column lineage', canRefresh: true };
  if (input.notReady === 'outdated') return { tone: 'idle', headline: 'Column lineage needs a refresh', canRefresh: true };
  if (input.notReady === 'error') return { tone: 'fail', headline: 'Column lineage failed', canRefresh: true };
  if (input.failed) return { tone: 'fail', headline: 'Couldn’t rank columns', canRefresh: true };
  if (input.loading || input.total === null) return { tone: 'running', headline: 'Ranking columns…', canRefresh: false };
  if (input.total === 0) return { tone: 'ok', headline: 'No gaps found', canRefresh: true };
  return {
    tone: 'warn',
    headline: `${input.total} column${input.total === 1 ? '' : 's'} could use a test`,
    canRefresh: true,
  };
}

/** Badge beside the Test Gaps tab label (same shape as healthStatus.tabBadge): the gap count, or a dot while lineage runs. */
export function testGapsBadge(
  total: number | null,
  notReady: 'missing' | 'running' | 'outdated' | 'error' | null,
): { label: string | null; tone: 'warn' | 'running' } | null {
  if (notReady === 'running') return { label: null, tone: 'running' };
  if (total !== null && total > 0) return { label: String(total), tone: 'warn' };
  return null;
}

/** Whether an ignored row would still be suggested if it were unignored. */
export function ignoredStatus(row: Pick<IgnoredGapDto, 'still_a_gap'>): string {
  if (row.still_a_gap === null) return 'unknown — refresh column lineage';
  return row.still_a_gap ? 'still a gap' : 'no longer a gap';
}


export const TEST_LABEL: Record<string, string> = {
  not_null: 'not_null',
  unique: 'unique',
  relationships: 'relationships',
  unique_combination_of_columns: 'unique combination',
};

/** Each suggested test type with how many rows suggest it (for filter chips). */
export function testCounts(rows: Pick<TestGapDto, 'candidates'>[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const test of new Set(r.candidates.map((c) => c.test))) counts.set(test, (counts.get(test) ?? 0) + 1);
  }
  const order = Object.keys(TEST_LABEL);
  return [...counts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

/** Rows matching the search (model or column) and, when any are picked, one of the test types. */
export function filterGaps<T extends { name: string; candidates: { test: string }[] }>(
  rows: T[], query: string, tests: ReadonlySet<string>, subject: (row: T) => string,
): T[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || subject(r).toLowerCase().includes(q))
    && (tests.size === 0 || r.candidates.some((c) => tests.has(c.test))));
}
