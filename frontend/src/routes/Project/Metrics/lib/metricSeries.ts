// Reading and formatting metric query values: warehouse times and numbers, compact values and
// time ticks per grain. Pure; unit-tested in metricSeries.test.ts.

/** A warehouse time value as UTC ms: dates and naive timestamps are read as UTC. */
export function parseTime(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim().replace(' ', 'T');
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/.test(text);
  const iso = /^\d{4}-\d\d-\d\d$/.test(text) ? `${text}T00:00:00Z` : hasZone ? text : `${text}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const FULL = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const SMALL = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });

/** Axis / tile value: compact above 10k, 3 significant digits below 1. */
export function formatValue(value: number | null | undefined, compact = true): string {
  if (value == null) return '–';
  const abs = Math.abs(value);
  if (compact && abs >= 10_000) return COMPACT.format(value);
  if (abs > 0 && abs < 1) return SMALL.format(value);
  return FULL.format(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A time tick / tooltip label at the query's grain (UTC). */
export function formatTime(ms: number, grain: string): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mon = MONTHS[d.getUTCMonth()];
  switch (grain) {
    case 'year': return String(y);
    case 'quarter': return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}`;
    case 'month': return `${mon} ${y}`;
    case 'hour': return `${mon} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    default: return `${mon} ${d.getUTCDate()}, ${y}`;
  }
}
