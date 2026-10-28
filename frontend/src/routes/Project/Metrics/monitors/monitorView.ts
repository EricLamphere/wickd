// Metric monitors: status → pill/badge, sparkline + expected-band geometry, per-metric
// status for the DAG and Impact. Pure; unit-tested in monitorView.test.ts.
import type { MonitorDto, MonitorPointDto, MonitorStatus, PointKind } from '../../../../lib/monitorsApi';
import { TONE_BADGE, TONE_DOT, TONE_TEXT, type Tone } from '../../components/health/healthStatus';

export const STATUS_RANK: Record<MonitorStatus, number> = {
  error: 4, anomaly: 3, warn: 2, ok: 1, not_enough_history: 0,
};

const STATUS_META: Record<MonitorStatus, { label: string; tone: Tone }> = {
  anomaly: { label: 'Anomaly', tone: 'fail' },
  error: { label: 'Refresh failed', tone: 'fail' },
  warn: { label: 'Warning', tone: 'warn' },
  ok: { label: 'Normal', tone: 'ok' },
  not_enough_history: { label: 'Learning', tone: 'idle' },
};

export interface StatusStyle {
  label: string;
  tone: Tone;
  pill: string;
  dot: string;
  text: string;
}

/** Pill / dot / text classes for a monitor status (null = never checked). */
export function statusStyle(status: MonitorStatus | null | undefined, running = false): StatusStyle {
  if (running) return { label: 'Checking…', tone: 'running', pill: TONE_BADGE.running, dot: TONE_DOT.running, text: TONE_TEXT.running };
  if (!status) return { label: 'Not checked', tone: 'idle', pill: TONE_BADGE.idle, dot: TONE_DOT.idle, text: TONE_TEXT.idle };
  const { label, tone } = STATUS_META[status];
  return { label, tone, pill: TONE_BADGE[tone], dot: TONE_DOT[tone], text: TONE_TEXT[tone] };
}

export const KIND_LABEL: Record<PointKind, string> = {
  none: '',
  warn: 'Unusual',
  anomaly: 'Spike / drop',
  missing: 'Missing',
  zero: 'Zero',
  restated: 'Restated',
  level_shift: 'Level shift',
};

/** Kinds drawn as a red marker (the rest of the flags are amber). */
export const ALARM_KINDS: ReadonlySet<PointKind> = new Set(['anomaly', 'missing', 'zero', 'level_shift']);

export function kindTone(kind: PointKind): Tone {
  if (kind === 'none') return 'idle';
  return ALARM_KINDS.has(kind) ? 'fail' : 'warn';
}

export function monitorTitle(m: Pick<MonitorDto, 'metric' | 'grain' | 'dimension'>): string {
  return `${m.metric} · ${m.grain}${m.dimension ? ` · by ${m.dimension}` : ''}`;
}

export interface MetricMonitorState {
  status: MonitorStatus | null;
  headline: string;
  monitors: number;
}

/** Worst latest status per monitored metric (enabled monitors only), for DAG dots and Impact flags. */
export function statusesByMetric(monitors: MonitorDto[]): Map<string, MetricMonitorState> {
  const out = new Map<string, MetricMonitorState>();
  for (const m of monitors) {
    if (!m.enabled) continue;
    const status = m.latest?.status ?? null;
    const prev = out.get(m.metric);
    const worse = !prev || (status !== null && (prev.status === null || STATUS_RANK[status] > STATUS_RANK[prev.status]));
    const headline = m.latest?.headline ?? 'Not checked yet';
    out.set(m.metric, worse
      ? { status, headline, monitors: (prev?.monitors ?? 0) + 1 }
      : { ...prev, monitors: prev.monitors + 1 });
  }
  return out;
}

// ── sparkline geometry ──────────────────────────────────────────────────────

/** The band's floor at 0 for a series that's never negative (counts, revenue). */
export function clampBand(points: MonitorPointDto[]): MonitorPointDto[] {
  if (points.some((p) => typeof p.value === 'number' && p.value < 0)) return points;
  return points.map((p) => (p.low !== null && p.low < 0 ? { ...p, low: 0 } : p));
}

export interface SparkGeometry {
  /** the value line; gaps (nulls) break it into segments */
  line: string;
  /** the expected band (low..high), closed polygons per run of scored points */
  band: string;
  flagged: { x: number; y: number; kind: PointKind }[];
  /** the partial period's point, drawn hollow */
  partial: { x: number; y: number } | null;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/** SVG paths for a value line over its expected band, in a width × height box with `pad` inside. */
export function sparkGeometry(points: MonitorPointDto[], width: number, height: number, pad = 2): SparkGeometry {
  const empty: SparkGeometry = { line: '', band: '', flagged: [], partial: null };
  if (points.length === 0) return empty;
  const values = points.flatMap((p) => [p.value, p.low, p.high]).filter(finite);
  if (values.length === 0) return empty;
  const flat = Math.min(...values) === Math.max(...values);
  const lo = Math.min(...values) - (flat ? 1 : 0);
  const hi = Math.max(...values) + (flat ? 1 : 0);
  const step = points.length > 1 ? (width - 2 * pad) / (points.length - 1) : 0;
  const x = (i: number) => pad + i * step;
  const y = (v: number) => pad + (height - 2 * pad) * (1 - (v - lo) / (hi - lo));

  const line: string[] = [];
  let open = false;
  points.forEach((p, i) => {
    if (!finite(p.value)) { open = false; return; }
    line.push(`${open ? 'L' : 'M'}${fmt(x(i))},${fmt(y(p.value))}`);
    open = true;
  });

  const band: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      const top = run.map((i, k) => `${k ? 'L' : 'M'}${fmt(x(i))},${fmt(y(points[i].high!))}`);
      const bottom = [...run].reverse().map((i) => `L${fmt(x(i))},${fmt(y(points[i].low!))}`);
      band.push(`${top.join('')}${bottom.join('')}Z`);
    }
    run = [];
  };
  points.forEach((p, i) => (finite(p.low) && finite(p.high) ? run.push(i) : flush()));
  flush();

  // a missing period has no value: its marker sits on the floor
  const flagged = points.flatMap((p, i) => (
    p.kind === 'none' ? [] : [{ x: x(i), y: y(finite(p.value) ? p.value : lo), kind: p.kind }]
  ));
  const lastIndex = points.length - 1;
  const last = points[lastIndex];
  const partial = last.partial && finite(last.value) ? { x: x(lastIndex), y: y(last.value) } : null;
  return { line: line.join(''), band: band.join(''), flagged, partial };
}

// ── numbers ─────────────────────────────────────────────────────────────────

export function formatNumber(v: number | null | undefined): string {
  if (!finite(v)) return '—';
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  return Number(v.toPrecision(4)).toLocaleString();
}

/** "+12% vs expected" style comparison, or null when either side is missing. */
export function vsExpected(value: number | null | undefined, expected: number | null | undefined): string | null {
  if (!finite(value) || !finite(expected)) return null;
  if (expected === 0) return value === 0 ? 'as expected' : null;
  const pct = ((value - expected) / Math.abs(expected)) * 100;
  if (Math.abs(pct) < 0.5) return 'as expected';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}% vs expected`;
}

/** Downstream monitored metrics in an impact result: how many, and how many look wrong right now. */
export function monitoredDownstream(
  metricNames: string[], statuses: ReadonlyMap<string, MetricMonitorState>,
): { count: number; alarming: string[] } {
  const monitored = [...new Set(metricNames)].filter((n) => statuses.has(n));
  const alarming = monitored.filter((n) => {
    const s = statuses.get(n)?.status;
    return s === 'anomaly' || s === 'warn' || s === 'error';
  });
  return { count: monitored.length, alarming };
}
