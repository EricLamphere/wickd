// Pure helpers for data diff (Pro, plan 06): the Impact table's Data badge, the drawer's
// count bar and sample tables, labels, and the per-model remembered key.
import { ApiError } from '../../../lib/api';
import type { DataDiffCounts, DataDiffDto, DataDiffResult, DataDiffStatus } from '../../../lib/dataDiffApi';

export type BadgeTone = 'muted' | 'ok' | 'warn' | 'error' | 'running';

export interface DiffBadge {
  text: string;
  tone: BadgeTone;
  title: string;
}

const DIFFABLE_TYPES = new Set(['model', 'seed', 'snapshot']);

/** Nodes data diff can compare: built models, seeds and snapshots (not ephemeral). */
export function isDiffable(node: { resource_type: string; materialized?: string | null }): boolean {
  return DIFFABLE_TYPES.has(node.resource_type) && node.materialized !== 'ephemeral';
}

const PHASES: Record<string, string> = {
  queued: 'Waiting…',
  building: 'Building in dev…',
  resolving: 'Reading both targets…',
  probing: 'Reading columns…',
  comparing: 'Comparing rows…',
};

export function phaseLabel(phase: string | null | undefined): string {
  return (phase && PHASES[phase]) || 'Diffing…';
}

const KEY_SOURCES: Record<string, string> = {
  user: 'picked by you',
  contract: 'contract primary key',
  unique_test: 'unique test',
  unique_combination: 'unique combination test',
  detected: 'detected from SQL',
};

export function keySourceLabel(source: string | null | undefined): string {
  return (source && KEY_SOURCES[source]) || '';
}

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString();

const ERROR_BADGES: Record<string, string> = {
  prod_missing: 'not in prod',
  dev_missing: 'not built in dev',
  duplicate_keys: 'key not unique',
  build_failed: 'build failed',
  same_relation: 'same relation',
};

function schemaChanged(result: DataDiffResult | null): boolean {
  const s = result?.schema;
  return !!s && (s.added.length + s.removed.length + s.retyped.length) > 0;
}

/** The Data column's short summary of a model's latest diff. */
export function diffBadge(dto: DataDiffDto): DiffBadge {
  if (dto.status === 'running') return { text: 'diffing…', tone: 'running', title: phaseLabel(dto.phase) };
  const result = dto.result;
  if (dto.status === 'error') {
    const code = result?.error?.code ?? '';
    return { text: ERROR_BADGES[code] ?? 'diff failed', tone: code === 'prod_missing' ? 'warn' : 'error',
             title: dto.error_message ?? 'The diff failed' };
  }
  const c: DataDiffCounts = result?.counts ?? {};
  const title = result?.headline ?? '';
  const approx = result?.estimated ? '≈' : '';
  if (c.added == null) {
    if ((c.dev_rows ?? 0) !== (c.prod_rows ?? 0)) return { text: `${n(c.dev_rows)} vs ${n(c.prod_rows)} rows`, tone: 'warn', title };
    return schemaChanged(result) ? { text: 'schema changed', tone: 'warn', title } : { text: 'same count', tone: 'ok', title };
  }
  const parts = [
    c.added ? `+${approx}${n(c.added)}` : '',
    c.removed ? `−${approx}${n(c.removed)}` : '',
    c.changed ? `~${approx}${n(c.changed)}` : '',
  ].filter(Boolean);
  if (parts.length === 0) {
    return schemaChanged(result) ? { text: 'schema changed', tone: 'warn', title } : { text: 'no changes', tone: 'ok', title };
  }
  return { text: `${parts.join(' ')} rows`, tone: 'warn', title };
}

export function latestByModel(diffs: readonly DataDiffDto[] | undefined): Map<string, DataDiffDto> {
  return new Map((diffs ?? []).map((d) => [d.unique_id, d]));
}

export interface BarSegment { status: DataDiffStatus | 'unchanged'; count: number; pct: number }

/** Proportions for the count bar: unchanged / changed / added / removed over all rows seen. */
export function countSegments(c: DataDiffCounts | undefined): BarSegment[] {
  if (!c || c.added == null) return [];
  const parts: [BarSegment['status'], number][] = [
    ['unchanged', c.unchanged ?? 0], ['changed', c.changed ?? 0], ['added', c.added ?? 0], ['removed', c.removed ?? 0],
  ];
  const total = parts.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0) return [];
  return parts.filter(([, v]) => v > 0).map(([status, count]) => ({ status, count, pct: (count / total) * 100 }));
}

export interface SampleTable {
  columns: string[];
  rows: unknown[][];
  /** `${row}:${col}` of cells whose value differs between dev and prod */
  changed: Set<string>;
}

/** Sample rows for one status. Changed rows show each differing column's dev and prod value side by side. */
export function sampleTable(result: DataDiffResult | null | undefined, status: DataDiffStatus): SampleTable {
  const samples = result?.samples?.[status] ?? [];
  const keyCols = result?.sample_columns?.key ?? [];
  const cols = result?.sample_columns?.columns ?? [];
  if (status !== 'changed') {
    const side = status === 'added' ? 'dev' : 'prod';
    return { columns: [...keyCols, ...cols], rows: samples.map((s) => [...s.key, ...(s[side] ?? [])]), changed: new Set() };
  }
  const differing = cols.filter((c) => samples.some((s) => s.changed.includes(c)));
  const columns = [...keyCols, ...differing.flatMap((c) => [`${c} (dev)`, `${c} (prod)`])];
  const changed = new Set<string>();
  const rows = samples.map((s, ri) => {
    const values: unknown[] = [...s.key];
    differing.forEach((c, i) => {
      const idx = cols.indexOf(c);
      values.push(s.dev?.[idx], s.prod?.[idx]);
      if (s.changed.includes(c)) {
        changed.add(`${ri}:${keyCols.length + i * 2}`);
        changed.add(`${ri}:${keyCols.length + i * 2 + 1}`);
      }
    });
    return values;
  });
  return { columns, rows, changed };
}

export function formatDelta(value: number | null | undefined): string {
  if (value == null || Math.abs(value) < 0.005) return '';
  const sign = value < 0 ? '−' : '+';
  return `${sign}${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return '';
  const pct = value * 100;
  return `${pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

export function dataDiffStartError(err: unknown): string | null {
  if (err instanceof ApiError && err.status === 409) return null; // already running; its events update the query
  if (err instanceof ApiError && err.status === 503) return 'Data diff is unavailable in this build (the wickd Pro package is not installed).';
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | string | null;
    if (typeof body === 'string') return body;
    if (body && typeof body.message === 'string') return body.message;
  }
  return err instanceof Error ? err.message : 'Failed to start the data diff';
}

// ── remembered keys (per project, per model) ─────────────────────────────────

const keyStorage = (projectId: number) => `wickd:data-diff-keys:${projectId}`;

export function readKeys(projectId: number): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyStorage(projectId)) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberKey(projectId: number, uniqueId: string, key: string[] | null): Record<string, string[]> {
  const next = { ...readKeys(projectId) };
  if (key && key.length > 0) next[uniqueId] = key;
  else delete next[uniqueId];
  try {
    localStorage.setItem(keyStorage(projectId), JSON.stringify(next));
  } catch {
    // storage unavailable: the key still applies to this run
  }
  return next;
}

/** Comma-separated key text → column names. */
export function parseKeyInput(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

const BUILD_KEY = 'wickd:data-diff-build';

/** Whether to `dbt run` the models in dev before diffing (default on; remembered per browser). */
export function readBuildPreference(): boolean {
  try {
    return localStorage.getItem(BUILD_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeBuildPreference(on: boolean): void {
  try {
    localStorage.setItem(BUILD_KEY, String(on));
  } catch {
    // a per-viewer convenience only
  }
}
