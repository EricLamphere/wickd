// The query composer's language (plan 16): one line of chips, e.g.
//   revenue orders by customer__region · last 90 days vs last year · where tier = gold · top 10
// lex() splits the text into words, parse() turns them into chips over the catalog's names
// (metrics by name or label, dimensions by name, label or unambiguous last part), date and
// comparison phrases (composerDates.ts), filters and `top N`. Text it doesn't understand
// becomes a draft chip with the reason. A construct cut off at the end (`by`, `where tier`)
// is reported as `pending`, which tells the suggestions what comes next (composerSuggest.ts).
// The chips ⇄ widget mapping is in composerWidget.ts. Pure; unit-tested in composer.test.ts.
import type { ComparePeriod, CurrentPeriod, Grain } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { compareLabel, currentLabel } from '../dashboards/periods';
import { compareText, parseComparePhrase, parseDatePhrase, periodText } from './composerDates';
import { buildFilter, filterLabel, FILTER_OPS, groupByOptions, METRIC_TIME, type FilterOp, type GroupByOption } from './metricQuery';

export type Chip =
  | { kind: 'metric'; name: string }
  /** over time (`auto`) or at a grain: `by month` */
  | { kind: 'time'; grain: Grain }
  | { kind: 'dimension'; name: string }
  /** a MetricFlow `where` string */
  | { kind: 'filter'; where: string }
  | { kind: 'period'; value: CurrentPeriod }
  | { kind: 'compare'; value: ComparePeriod }
  | { kind: 'top'; n: number }
  /** text the composer didn't understand */
  | { kind: 'draft'; text: string; error: string };

/** What the text ends in the middle of (the suggestions offer what comes next). */
export type Pending =
  | { kind: 'group' }
  | { kind: 'filter_dimension' }
  | { kind: 'operator'; dimension: string }
  | { kind: 'value'; dimension: string; op: FilterOp }
  | { kind: 'compare' }
  | { kind: 'number' };

export interface Parsed {
  chips: Chip[];
  pending: Pending | null;
}

export interface Word {
  text: string;
  lower: string;
  quoted: boolean;
  /** , · ( ) */
  punct: boolean;
  start: number;
  end: number;
}

export interface ComposerIndex {
  catalog: SemanticCatalogDto;
  /** lower-case name or label → metric name */
  metrics: Map<string, string>;
  /** every dimension any metric has, by name */
  dimensions: Map<string, GroupByOption>;
  /** lower-case name, label or unambiguous last part (`region` for customer__region) → name */
  dimensionAliases: Map<string, string>;
}

export const GRAINS: readonly Grain[] = ['day', 'week', 'month', 'quarter', 'year'];
const ADVERBS: Record<string, Grain> = { daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };
export const MAX_TOP = 500;
const MAX_PHRASE_WORDS = 7;
const PUNCT = new Set([',', '·', '(', ')']);
const OPERATOR = /^(!=|<>|>=|<=|=|>|<)/;
const WORD_END = /[\s,·()'"=<>!]/;

// ── index ────────────────────────────────────────────────────────────────────

export function buildIndex(catalog: SemanticCatalogDto): ComposerIndex {
  const metrics = new Map<string, string>();
  for (const m of catalog.metrics) {
    if (m.label) metrics.set(m.label.toLowerCase(), m.name);
  }
  // names win over another metric's label
  for (const m of catalog.metrics) metrics.set(m.name.toLowerCase(), m.name);
  const dimensions = new Map<string, GroupByOption>();
  for (const m of catalog.metrics) {
    for (const o of groupByOptions(catalog, [m.name])) if (!dimensions.has(o.name)) dimensions.set(o.name, o);
  }
  const aliases = new Map<string, string>();
  const suffixes = new Map<string, string[]>();
  for (const o of dimensions.values()) {
    const last = o.name.split('__').pop()!.toLowerCase();
    suffixes.set(last, [...(suffixes.get(last) ?? []), o.name]);
  }
  for (const [last, names] of suffixes) if (names.length === 1) aliases.set(last, names[0]);
  for (const o of dimensions.values()) if (o.label) aliases.set(o.label.toLowerCase(), o.name);
  for (const o of dimensions.values()) aliases.set(o.name.toLowerCase(), o.name);
  return { catalog, metrics, dimensions, dimensionAliases: aliases };
}

// ── lexer ────────────────────────────────────────────────────────────────────

export function lex(input: string): Word[] {
  const words: Word[] = [];
  const push = (text: string, start: number, end: number, extra: Partial<Word> = {}) =>
    words.push({ text, lower: text.toLowerCase(), quoted: false, punct: false, start, end, ...extra });
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (PUNCT.has(c)) { push(c, i, i + 1, { punct: true }); i += 1; continue; }
    if (c === "'" || c === '"') {
      const close = input.indexOf(c, i + 1);
      const end = close < 0 ? input.length : close + 1;
      push(input.slice(i + 1, close < 0 ? input.length : close), i, end, { quoted: true });
      i = end;
      continue;
    }
    const op = input.slice(i).match(OPERATOR);
    if (op) { push(op[1] === '<>' ? '!=' : op[1], i, i + op[1].length); i += op[1].length; continue; }
    let j = i;
    while (j < input.length && !WORD_END.test(input[j])) j += 1;
    if (j === i) j += 1; // a lone `!`
    push(input.slice(i, j), i, j);
    i = j;
  }
  return words;
}

// ── parser ───────────────────────────────────────────────────────────────────

interface Match<T> {
  value: T;
  len: number;
}

/** The longest run of plain words from `i` that `lookup` recognises. */
function longest<T>(words: Word[], i: number, lookup: (phrase: string) => T | null | undefined, max = MAX_PHRASE_WORDS): Match<T> | null {
  let limit = 0;
  while (limit < max && i + limit < words.length && !words[i + limit].punct && !words[i + limit].quoted) limit += 1;
  for (let len = limit; len > 0; len -= 1) {
    const phrase = words.slice(i, i + len).map((w) => w.lower).join(' ');
    const value = lookup(phrase);
    if (value !== null && value !== undefined) return { value, len };
  }
  return null;
}

function grainOf(word: string): Grain | null {
  if (word === 'time' || word === METRIC_TIME) return 'auto';
  const plain = word.replace(/s$/, '');
  if ((GRAINS as string[]).includes(plain)) return plain as Grain;
  const suffixed = word.match(/^metric_time__(\w+)$/);
  return suffixed && (GRAINS as string[]).includes(suffixed[1]) ? suffixed[1] as Grain : null;
}

/** Operators in the order they're tried (longest first). */
const OPERATOR_WORDS: [string[], FilterOp][] = [
  [['is', 'not', 'null'], 'is not null'], [['is', 'null'], 'is null'], [['not', 'in'], 'not in'],
  [['is', 'not'], '!='], [['!='], '!='], [['>='], '>='], [['<='], '<='], [['='], '='], [['>'], '>'], [['<'], '<'],
  [['in'], 'in'], [['like'], 'like'], [['is'], '='],
];

function operatorAt(words: Word[], i: number): Match<FilterOp> | null {
  for (const [seq, op] of OPERATOR_WORDS) {
    if (seq.every((s, k) => words[i + k] && !words[i + k].quoted && words[i + k].lower === s)) return { value: op, len: seq.length };
  }
  return null;
}

class Parser {
  readonly chips: Chip[] = [];
  pending: Pending | null = null;
  private unknown: Word[] = [];
  private readonly words: Word[];

  constructor(private readonly input: string, private readonly index: ComposerIndex, private readonly today: Date) {
    this.words = lex(input);
  }

  private text(from: number, to: number): string {
    return this.input.slice(this.words[from].start, this.words[Math.max(from, to - 1)].end);
  }

  private draft(from: number, to: number, error: string) {
    this.flush();
    this.chips.push({ kind: 'draft', text: this.text(from, to), error });
  }

  private flush() {
    if (!this.unknown.length) return;
    const first = this.unknown[0];
    const last = this.unknown[this.unknown.length - 1];
    this.chips.push({ kind: 'draft', text: this.input.slice(first.start, last.end), error: 'Not a metric, a date or a keyword (by, where, vs, top)' });
    this.unknown = [];
  }

  private push(chip: Chip) {
    this.flush();
    this.chips.push(chip);
  }

  private dimensionAt(i: number): Match<string> | null {
    return longest(this.words, i, (p) => this.index.dimensionAliases.get(p));
  }

  run(): Parsed {
    const w = this.words;
    let i = 0;
    while (i < w.length) {
      const word = w[i];
      const next = w[i + 1]?.lower;
      if (word.punct || (word.lower === 'and' && !word.quoted)) { this.flush(); i += 1; continue; }
      if (!word.quoted) {
        if (word.lower === 'by') { i = this.groups(i + 1); continue; }
        if (word.lower === 'where') { i = this.filters(i + 1); continue; }
        if (word.lower === 'vs' || word.lower === 'versus') { i = this.compare(i + 1); continue; }
        if (word.lower === 'top') { i = this.top(i + 1); continue; }
        if (word.lower === 'over' && next === 'time') { this.push({ kind: 'time', grain: 'auto' }); i += 2; continue; }
        if (word.lower === 'no' && (next === 'compare' || next === 'comparison')) { this.push({ kind: 'compare', value: 'none' }); i += 2; continue; }
        if (ADVERBS[word.lower]) { this.push({ kind: 'time', grain: ADVERBS[word.lower] }); i += 1; continue; }
      }
      // a metric label and a date phrase can overlap ("last month revenue"): the longer wins, a tie is the metric
      const date = longest(w, i, (p) => parseDatePhrase(p, this.today));
      const metric = longest(w, i, (p) => this.index.metrics.get(p));
      if (metric && (!date || metric.len >= date.len)) { this.push({ kind: 'metric', name: metric.value }); i += metric.len; continue; }
      if (date) { this.push({ kind: 'period', value: date.value }); i += date.len; continue; }
      const dim = this.dimensionAt(i);
      if (dim) { this.draft(i, i + dim.len, `A dimension: type "by ${dim.value}" or "where ${dim.value} = …"`); i += dim.len; continue; }
      this.unknown.push(word);
      i += 1;
    }
    this.flush();
    return { chips: this.chips, pending: this.pending };
  }

  /** `by a, b and month` */
  private groups(start: number): number {
    const w = this.words;
    let j = start;
    let found = 0;
    for (;;) {
      if (j >= w.length) { if (!found) this.pending = { kind: 'group' }; return j; }
      const grain = w[j].quoted ? null : grainOf(w[j].lower);
      const dim = grain ? null : this.dimensionAt(j);
      if (grain) { this.push({ kind: 'time', grain }); j += 1; }
      else if (dim) { this.push({ kind: 'dimension', name: dim.value }); j += dim.len; }
      else if (!found) { this.draft(start - 1, j + 1, `No dimension called “${w[j].text}”`); return j + 1; }
      else return j;
      found += 1;
      const sep = w[j];
      if (!sep || !((sep.punct && sep.text === ',') || sep.lower === 'and' || sep.lower === 'by')) return j;
      if (j + 1 >= w.length) { this.pending = { kind: 'group' }; return j + 1; }
      const after = w[j + 1];
      const continues = !after.quoted && (grainOf(after.lower) || this.dimensionAt(j + 1));
      if (!continues && sep.lower === 'and') return j;
      j += 1;
    }
  }

  /** `where a = 1 and b in (x, y)` */
  private filters(start: number): number {
    const w = this.words;
    let j = start;
    for (;;) {
      const from = j - 1; // the `where` / `and`
      if (j >= w.length) { this.pending = { kind: 'filter_dimension' }; return j; }
      const dim = this.dimensionAt(j);
      if (!dim) { this.draft(from, j + 1, `No dimension called “${w[j].text}”`); return j + 1; }
      const option = this.index.dimensions.get(dim.value)!;
      j += dim.len;
      if (j >= w.length) { this.pending = { kind: 'operator', dimension: dim.value }; return j; }
      const op = operatorAt(w, j);
      if (!op) { this.draft(from, j, 'Needs an operator: =, !=, >, <, in, like, is null'); return j; }
      j += op.len;
      let value = '';
      if (op.value !== 'is null' && op.value !== 'is not null') {
        const values = this.values(j, op.value === 'in' || op.value === 'not in');
        if (values === null) { this.pending = { kind: 'value', dimension: dim.value, op: op.value }; return w.length; }
        if (!values.items.length) { this.draft(from, j, 'Needs a value'); return j; }
        value = values.items.join(', ');
        j = values.end;
      }
      this.push({ kind: 'filter', where: buildFilter(option, op.value, value) });
      if (w[j]?.lower !== 'and' || !w[j + 1] || !this.dimensionAt(j + 1)) return j;
      j += 1;
    }
  }

  /** A value, or several separated by commas (in parentheses or not); null = the text ends where one is due. */
  private values(start: number, many: boolean): { items: string[]; end: number } | null {
    const w = this.words;
    let j = start;
    const items: string[] = [];
    if (w[j]?.text === '(') j += 1;
    for (;;) {
      if (j >= w.length) return null;
      if (w[j].punct) return { items, end: j };
      items.push(w[j].text);
      j += 1;
      if (!many || w[j]?.text !== ',') break;
      j += 1;
    }
    if (w[j]?.text === ')') j += 1;
    return { items, end: j };
  }

  private compare(start: number): number {
    if (start >= this.words.length) { this.pending = { kind: 'compare' }; return start; }
    const match = longest(this.words, start, (p) => parseComparePhrase(p, this.today));
    if (!match) { this.draft(start - 1, start + 1, 'Compare with: previous, last year, nothing, or dates'); return start + 1; }
    this.push({ kind: 'compare', value: match.value });
    return start + match.len;
  }

  private top(start: number): number {
    const word = this.words[start];
    if (!word) { this.pending = { kind: 'number' }; return start; }
    const n = Number(word.text);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TOP) { this.draft(start - 1, start + 1, `top takes a number from 1 to ${MAX_TOP}`); return start + 1; }
    this.push({ kind: 'top', n });
    return start + 1;
  }
}

export function parse(input: string, index: ComposerIndex, today: Date = new Date()): Parsed {
  return new Parser(input, index, today).run();
}

// ── chips as text ────────────────────────────────────────────────────────────

/** What a chip shows. */
export function chipLabel(chip: Chip, labels: Map<string, string>): string {
  switch (chip.kind) {
    case 'metric': return labels.get(chip.name) ?? chip.name;
    case 'time': return chip.grain === 'auto' ? 'over time' : `by ${chip.grain}`;
    case 'dimension': return `by ${chip.name}`;
    case 'filter': return `where ${filterLabel(chip.where)}`;
    case 'period': return currentLabel(chip.value);
    case 'compare': return chip.value === 'none' ? 'no comparison' : `vs ${compareLabel(chip.value).toLowerCase()}`;
    case 'top': return `top ${chip.n}`;
    case 'draft': return chip.text;
  }
}

/** Text that parses back to the chip (clicking a chip turns it back into text to edit). */
export function chipText(chip: Chip): string {
  switch (chip.kind) {
    case 'metric': return chip.name;
    case 'time': return chip.grain === 'auto' ? 'over time' : `by ${chip.grain}`;
    case 'dimension': return `by ${chip.name}`;
    case 'filter': return `where ${filterLabel(chip.where)}`;
    case 'period': return periodText(chip.value);
    case 'compare': return compareText(chip.value);
    case 'top': return `top ${chip.n}`;
    case 'draft': return chip.text;
  }
}

export function sameChip(a: Chip, b: Chip): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a chip can be edited as text: its text parses back to the same chip (an advanced
 *  MetricFlow filter written in Configure may not). */
export function editableAsText(chip: Chip, index: ComposerIndex, today: Date = new Date()): boolean {
  if (chip.kind === 'draft') return true;
  const { chips } = parse(chipText(chip), index, today);
  return chips.length === 1 && sameChip(chips[0], chip);
}

/** Kinds a line holds once: a newly typed one replaces the old in place. */
const SINGLE_KINDS = new Set<Chip['kind']>(['period', 'compare', 'top', 'time']);

/** `existing` with `added` appended (a repeated metric skipped, a second period/compare/top/grain
 *  replacing the first where it stands). */
export function mergeChips(existing: Chip[], added: Chip[]): Chip[] {
  let out = [...existing];
  for (const chip of added) {
    const at = SINGLE_KINDS.has(chip.kind) ? out.findIndex((c) => c.kind === chip.kind) : -1;
    if (at >= 0) out = out.map((c, i) => (i === at ? chip : c));
    else if (!out.some((c) => c.kind !== 'draft' && sameChip(c, chip))) out = [...out, chip];
  }
  return out;
}

/** Whether a parse is finished chips only (nothing cut off, nothing unknown). */
export function isComplete(parsed: Parsed): boolean {
  return !parsed.pending && parsed.chips.length > 0 && parsed.chips.every((c) => c.kind !== 'draft');
}

export { FILTER_OPS };
