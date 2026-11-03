// The query composer's suggestions (plan 16): what fits where the cursor is (always the end of
// the text being typed). parse() of the text before the word being typed says what comes next
// (Pending): after `by` dimensions the metrics share and grains, after `where` dimensions then
// operators then values (fetched by the component: `values`), after `vs` comparisons, after
// `top` numbers; otherwise metrics (by name or label, fuzzy), keywords and date phrases.
// Multi-word phrases (`last 90 days`, a metric label) match across the last few words typed.
// Pure; unit-tested in composer.test.ts.
import type { Chip, ComposerIndex, Pending } from './composer';
import { GRAINS, parse } from './composer';
import { COMPARE_SUGGESTIONS, PERIOD_SUGGESTIONS } from './composerDates';
import { FILTER_OPS, groupByOptions } from './metricQuery';

export type SuggestionKind = 'metric' | 'dimension' | 'grain' | 'keyword' | 'date' | 'compare' | 'operator' | 'number' | 'value';

export interface Suggestion {
  kind: SuggestionKind;
  label: string;
  /** replaces the text from `from` to the end */
  insert: string;
  detail?: string;
}

export interface Suggestions {
  /** where the replaced text starts */
  from: number;
  items: Suggestion[];
  /** the cursor is on a filter value: the component fetches the dimension's values */
  values: { dimension: string; partial: string } | null;
}

interface Candidate extends Suggestion {
  /** texts it's matched against (lower case) */
  match: string[];
}

const MAX_ITEMS = 10;
const MAX_TAIL_WORDS = 3;
const KEYWORDS: Candidate[] = [
  { kind: 'keyword', label: 'by …', insert: 'by ', detail: 'break down by a dimension or a grain', match: ['by'] },
  { kind: 'keyword', label: 'over time', insert: 'over time', detail: 'a time series', match: ['over time'] },
  { kind: 'keyword', label: 'where …', insert: 'where ', detail: 'filter', match: ['where'] },
  { kind: 'keyword', label: 'vs …', insert: 'vs ', detail: 'compare with', match: ['vs'] },
  { kind: 'keyword', label: 'top …', insert: 'top ', detail: 'the top N values', match: ['top'] },
  { kind: 'keyword', label: 'no comparison', insert: 'no comparison', match: ['no comparison'] },
];

/** A value as it has to be typed: quoted when it has spaces or punctuation. */
export function valueInsert(value: string): string {
  if (value && !/[\s,()'"=<>!·]/.test(value)) return value;
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

function score(c: Candidate, tail: string, fuzzy: boolean): number {
  if (!tail) return 1;
  let best = -1;
  for (const text of c.match) {
    if (text.startsWith(tail)) best = Math.max(best, 100 - Math.min(text.length - tail.length, 50));
    else if (!fuzzy) continue;
    // the name after the entity (tier in customer__tier) counts most
    else if (text.includes('__') && text.split('__').pop()!.startsWith(tail)) best = Math.max(best, 70);
    else if (text.split(/[\s_]+/).some((part) => part.startsWith(tail))) best = Math.max(best, 40);
    else if (text.includes(tail)) best = Math.max(best, 20);
  }
  return best;
}

function metricsIn(chips: Chip[], prefix: string, index: ComposerIndex): string[] {
  const named = [...chips, ...parse(prefix, index).chips].filter((c) => c.kind === 'metric').map((c) => (c as { name: string }).name);
  return [...new Set(named)];
}

function candidates(pending: Pending | null, metrics: string[], index: ComposerIndex, hasMetrics: boolean): Candidate[] {
  const options = metrics.length ? groupByOptions(index.catalog, metrics) : [...index.dimensions.values()];
  const dims = (kind: 'categorical' | 'any') => options
    .filter((o) => kind === 'any' || o.kind === 'categorical')
    .map((o): Candidate => ({ kind: 'dimension', label: o.name, insert: o.name, detail: o.label ?? undefined, match: [o.name.toLowerCase(), ...(o.label ? [o.label.toLowerCase()] : [])] }));
  switch (pending?.kind) {
    case 'group':
      return [
        ...dims('categorical'),
        ...GRAINS.map((g): Candidate => ({ kind: 'grain', label: g, insert: g, detail: 'over time, by this grain', match: [g] })),
      ];
    case 'filter_dimension':
      return dims('any');
    case 'operator':
      return FILTER_OPS.map((op): Candidate => ({ kind: 'operator', label: op, insert: op, match: [op] }));
    case 'compare':
      return COMPARE_SUGGESTIONS.map((t): Candidate => ({ kind: 'compare', label: t, insert: t, match: [t] }));
    case 'number':
      return ['5', '10', '20', '50'].map((n): Candidate => ({ kind: 'number', label: n, insert: n, match: [n] }));
    default: {
      const metricItems = index.catalog.metrics.map((m): Candidate => ({
        kind: 'metric', label: m.label || m.name, insert: m.name, detail: m.label ? m.name : undefined,
        match: [m.name.toLowerCase(), ...(m.label ? [m.label.toLowerCase()] : [])],
      })).filter((c) => !metrics.includes(c.insert));
      const dates = PERIOD_SUGGESTIONS.map((t): Candidate => ({ kind: 'date', label: t.trim(), insert: t, match: [t.trim()] }));
      // with a metric picked, what to do with it comes first
      return hasMetrics ? [...KEYWORDS, ...metricItems, ...dates] : [...metricItems, ...KEYWORDS, ...dates];
    }
  }
}

function ranked(list: Candidate[], tail: string, fuzzy: boolean): Suggestion[] {
  return list
    .map((c, order) => ({ c, s: score(c, tail, fuzzy), order }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.order - b.order)
    .slice(0, MAX_ITEMS)
    .map(({ c: { match: _m, ...item } }) => item);
}

/** Word boundaries in `input` (start offsets of its words) and the word being typed. */
function boundaries(input: string): { starts: number[]; partialStart: number; partial: string } {
  const starts: number[] = [];
  const re = /\S+/g;
  for (let m = re.exec(input); m; m = re.exec(input)) starts.push(m.index);
  const open = openQuote(input);
  if (open >= 0) return { starts: starts.filter((s) => s < open), partialStart: open, partial: input.slice(open + 1) };
  const ended = !input.length || /\s$/.test(input);
  const partialStart = ended ? input.length : starts[starts.length - 1];
  return { starts: ended ? starts : starts.slice(0, -1), partialStart, partial: input.slice(partialStart) };
}

/** The offset of an unclosed quote (a value being typed), or -1. */
function openQuote(input: string): number {
  let open = -1;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (open >= 0) { if (c === input[open]) open = -1; } else if (c === "'" || c === '"') open = i;
  }
  return open;
}

export function suggest(input: string, chips: Chip[], index: ComposerIndex): Suggestions {
  const { starts, partialStart, partial } = boundaries(input);
  // longest tail first: "last 9" → last 90 days
  for (let k = Math.min(MAX_TAIL_WORDS, starts.length); k >= 0; k -= 1) {
    const from = k ? starts[starts.length - k] : partialStart;
    const prefix = input.slice(0, from);
    const pending = parse(prefix, index).pending;
    if (pending?.kind === 'value') {
      if (k) continue;
      return { from, items: [], values: { dimension: pending.dimension, partial: partial.replace(/^['"]/, '') } };
    }
    const tail = input.slice(from).toLowerCase().replace(/\s+/g, ' ');
    if (k && !tail.includes(' ')) continue;
    const metrics = metricsIn(chips, prefix, index);
    const list = candidates(pending, metrics, index, metrics.length > 0);
    const items = ranked(list, k ? tail : partial.toLowerCase(), !k);
    if (items.length || !k) return { from, items, values: null };
  }
  return { from: partialStart, items: [], values: null };
}

/** Value suggestions for a filter, narrowed to what's typed. */
export function valueSuggestions(values: string[], partial: string): Suggestion[] {
  const p = partial.toLowerCase();
  return values
    .filter((v) => !p || v.toLowerCase().includes(p))
    .sort((a, b) => Number(b.toLowerCase().startsWith(p)) - Number(a.toLowerCase().startsWith(p)))
    .slice(0, MAX_ITEMS)
    .map((v) => ({ kind: 'value', label: v, insert: valueInsert(v) }));
}
