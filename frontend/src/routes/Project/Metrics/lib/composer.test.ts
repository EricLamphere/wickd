import { describe, expect, it } from 'vitest';
import type { DashboardWidget } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { buildIndex, chipLabel, chipText, editableAsText, isComplete, lex, mergeChips, parse, type Chip } from './composer';
import { parseComparePhrase, parseDatePhrase, periodText } from './composerDates';
import { suggest, valueInsert, valueSuggestions } from './composerSuggest';
import { canInfer, fromWidget, inferType, sameWidget, toWidget } from './composerWidget';
import { emptyExploreWidget, EXPLORE_HEIGHT } from './exploreWidget';

const dim = (name: string, label: string | null = null) => ({ name, type: 'categorical', time_granularity: null, label, description: null });
const time = { name: 'metric_time__day', type: 'time', time_granularity: 'day', label: null, description: null };
const catalog = {
  metrics: [
    { name: 'revenue', label: 'Revenue', description: null, type: 'simple', semantic_models: ['orders'],
      dimensions: [time, dim('customer__region', 'Region'), dim('customer__tier'), dim('order__status')] },
    { name: 'orders', label: 'Order count', description: null, type: 'simple', semantic_models: ['orders'],
      dimensions: [time, dim('customer__region', 'Region'), dim('customer__tier'), dim('order__status')] },
    { name: 'aov', label: 'Average order value', description: null, type: 'ratio', semantic_models: ['orders'],
      dimensions: [time, dim('customer__region', 'Region'), dim('customer__tier')] },
  ],
  saved_queries: [],
} as unknown as SemanticCatalogDto;
const index = buildIndex(catalog);
// Wednesday 2026-11-04
const TODAY = new Date(2026, 10, 4);
const chips = (text: string) => parse(text, index, TODAY).chips;
const labels = new Map(catalog.metrics.map((m) => [m.name, m.label ?? m.name]));
const W = (w: Partial<DashboardWidget>): DashboardWidget => ({ ...emptyExploreWidget(), ...w });

describe('lex', () => {
  it('splits words, punctuation, operators and quoted values', () => {
    expect(lex(`where city='New York', a!=b (x)`).map((w) => w.text)).toEqual(['where', 'city', '=', 'New York', ',', 'a', '!=', 'b', '(', 'x', ')']);
    expect(lex(`a <> b`).map((w) => w.text)).toEqual(['a', '!=', 'b']);
    expect(lex(`'open`)[0]).toMatchObject({ text: 'open', quoted: true });
  });
});

describe('parse', () => {
  it('reads a whole line', () => {
    expect(chips('revenue orders by customer__region · last 90 days vs last year · where customer__tier = gold · top 10')).toEqual([
      { kind: 'metric', name: 'revenue' },
      { kind: 'metric', name: 'orders' },
      { kind: 'dimension', name: 'customer__region' },
      { kind: 'period', value: 'last_90_days' },
      { kind: 'compare', value: 'previous_year' },
      { kind: 'filter', where: "{{ Dimension('customer__tier') }} = 'gold'" },
      { kind: 'top', n: 10 },
    ]);
  });

  it('matches metrics and dimensions by label and an unambiguous last part', () => {
    expect(chips('order count by region')).toEqual([{ kind: 'metric', name: 'orders' }, { kind: 'dimension', name: 'customer__region' }]);
    expect(chips('Average Order Value by tier, status')).toEqual([
      { kind: 'metric', name: 'aov' }, { kind: 'dimension', name: 'customer__tier' }, { kind: 'dimension', name: 'order__status' },
    ]);
  });

  it('reads grains and over time', () => {
    expect(chips('revenue by month')).toEqual([{ kind: 'metric', name: 'revenue' }, { kind: 'time', grain: 'month' }]);
    expect(chips('revenue over time')[1]).toEqual({ kind: 'time', grain: 'auto' });
    expect(chips('revenue weekly by region')).toEqual([
      { kind: 'metric', name: 'revenue' }, { kind: 'time', grain: 'week' }, { kind: 'dimension', name: 'customer__region' },
    ]);
    expect(chips('revenue by metric_time__quarter')[1]).toEqual({ kind: 'time', grain: 'quarter' });
  });

  it('reads filters: operators, several values, null checks and `and`', () => {
    expect(chips("where region in (US, 'New Zealand') and tier is not null and status != open")).toEqual([
      { kind: 'filter', where: "{{ Dimension('customer__region') }} in ('US', 'New Zealand')" },
      { kind: 'filter', where: "{{ Dimension('customer__tier') }} is not null" },
      { kind: 'filter', where: "{{ Dimension('order__status') }} != 'open'" },
    ]);
    expect(chips('where tier is gold')[0]).toEqual({ kind: 'filter', where: "{{ Dimension('customer__tier') }} = 'gold'" });
    expect(chips('where metric_time >= 2026-01-01')[0]).toEqual({ kind: 'filter', where: "{{ TimeDimension('metric_time', 'day') }} >= '2026-01-01'" });
    expect(chips('where region = 5')[0]).toEqual({ kind: 'filter', where: "{{ Dimension('customer__region') }} = 5" });
  });

  it('keeps what it does not understand as draft chips, merging neighbours', () => {
    const out = chips('revenue foo bar by nowhere');
    expect(out[0]).toEqual({ kind: 'metric', name: 'revenue' });
    expect(out[1]).toMatchObject({ kind: 'draft', text: 'foo bar' });
    expect(out[2]).toMatchObject({ kind: 'draft', text: 'by nowhere' });
    expect(chips('revenue region')[1]).toMatchObject({ kind: 'draft', text: 'region', error: expect.stringContaining('by customer__region') });
    expect(chips('top many')[0]).toMatchObject({ kind: 'draft', text: 'top many' });
    expect(chips('vs whenever')[0]).toMatchObject({ kind: 'draft' });
    expect(chips('where region gold')[0]).toMatchObject({ kind: 'draft', error: expect.stringContaining('operator') });
  });

  it('reports a construct cut off at the end', () => {
    expect(parse('revenue by ', index).pending).toEqual({ kind: 'group' });
    expect(parse('revenue by region,', index).pending).toEqual({ kind: 'group' });
    expect(parse('where ', index).pending).toEqual({ kind: 'filter_dimension' });
    expect(parse('where tier', index).pending).toEqual({ kind: 'operator', dimension: 'customer__tier' });
    expect(parse('where tier =', index).pending).toEqual({ kind: 'value', dimension: 'customer__tier', op: '=' });
    expect(parse('where tier in (a,', index).pending).toEqual({ kind: 'value', dimension: 'customer__tier', op: 'in' });
    expect(parse('vs', index).pending).toEqual({ kind: 'compare' });
    expect(parse('top', index).pending).toEqual({ kind: 'number' });
    expect(parse('revenue by region', index).pending).toBeNull();
  });

  it('prefers metrics on ambiguous names unless after by/where', () => {
    const amb = buildIndex({ ...catalog, metrics: [...catalog.metrics, { ...catalog.metrics[0], name: 'status', label: null }] } as SemanticCatalogDto);
    expect(parse('status', amb).chips[0]).toEqual({ kind: 'metric', name: 'status' });
    expect(parse('revenue by status', amb).chips[1]).toEqual({ kind: 'dimension', name: 'order__status' });
  });
});

describe('date phrases', () => {
  const d = (t: string) => parseDatePhrase(t, TODAY);
  it('maps the presets', () => {
    expect(d('last 7 days')).toBe('last_7_days');
    expect(d('Past 30 days')).toBe('last_30_days');
    expect(d('YTD')).toBe('year_to_date');
    expect(d('this quarter')).toBe('quarter_to_date');
    expect(d('last 12 months')).toBe('last_12_months');
    expect(d('all time')).toBe('all_time');
    expect(d('last month')).toBe('last_month');
  });
  it('turns the rest into dates', () => {
    expect(d('today')).toEqual({ start: '2026-11-04', end: '2026-11-04' });
    expect(d('yesterday')).toEqual({ start: '2026-11-03', end: '2026-11-03' });
    expect(d('last 14 days')).toEqual({ start: '2026-10-22', end: '2026-11-04' });
    expect(d('last 2 weeks')).toEqual({ start: '2026-10-22', end: '2026-11-04' });
    expect(d('last 3 months')).toEqual({ start: '2026-08-05', end: '2026-11-04' });
    expect(d('this week')).toEqual({ start: '2026-11-02', end: '2026-11-04' });
    expect(d('last week')).toEqual({ start: '2026-10-26', end: '2026-11-01' });
    expect(d('last year')).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(d('2025')).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(d('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(d('Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(d('q4 2025')).toEqual({ start: '2025-10-01', end: '2025-12-31' });
    expect(d('2025 Q2')).toEqual({ start: '2025-04-01', end: '2025-06-30' });
    expect(d('since March')).toEqual({ start: '2026-03-01', end: '2026-11-04' });
    expect(d('december')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
    expect(d('since 2026-10-15')).toEqual({ start: '2026-10-15', end: '2026-11-04' });
    expect(d('2026-01-01 to 2026-03-31')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(d('from jan to mar 2026')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
  });
  it('rejects what is not a date', () => {
    for (const t of ['revenue', 'last', '2026-13', '2026-02-30', 'q5', 'last 0 days', 'mar to jan 2026']) expect(d(t)).toBeNull();
  });
  it('reads comparisons', () => {
    expect(parseComparePhrase('previous')).toBe('previous_period');
    expect(parseComparePhrase('the previous period')).toBe('previous_period');
    expect(parseComparePhrase('last year')).toBe('previous_year');
    expect(parseComparePhrase('nothing')).toBe('none');
    expect(parseComparePhrase('2025', TODAY)).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(parseComparePhrase('last 7 days', TODAY)).toEqual({ start: '2026-10-29', end: '2026-11-04' });
    expect(parseComparePhrase('whenever')).toBeNull();
  });
  it('writes periods back as text that parses', () => {
    for (const p of ['last_90_days', 'month_to_date', 'all_time', { start: '2026-01-01', end: '2026-03-31' }, { start: '2026-02-02', end: '2026-02-02' }] as const) {
      expect(parseDatePhrase(periodText(p), TODAY)).toEqual(p);
    }
  });
});

describe('chips ⇄ widget', () => {
  const widgets: DashboardWidget[] = [
    W({ type: 'timeseries', metrics: ['revenue', 'orders'], options: { grain: 'week', split_by: 'customer__region', top_n: 3, style: 'area' } }),
    W({ type: 'timeseries', metrics: ['revenue'] }),
    W({ type: 'bar', metrics: ['revenue'], options: { dimension: 'customer__region', stack_by: 'customer__tier', top_n: 20, orientation: 'horizontal' },
      filters: ["{{ Dimension('order__status') }} = 'done'"], period: { current: 'last_7_days', compare: 'previous_year' } }),
    W({ type: 'leaderboard', metrics: ['aov'], options: { dimension: 'customer__tier', top_n: 5, format: 'currency' } }),
    W({ type: 'table', metrics: ['revenue', 'orders'], options: { period_grain: 'month', dimensions: ['customer__region', 'customer__tier'], limit: 100 } }),
    W({ type: 'summary', metrics: ['revenue'], options: { higher_is_better: false }, period: { current: { start: '2026-01-01', end: '2026-01-31' } } }),
  ];

  it('round-trips every type, keeping options it does not own', () => {
    for (const w of widgets) {
      const back = toWidget(fromWidget(w), w, catalog);
      expect(back.errors).toEqual([]);
      expect(sameWidget(back.widget, w)).toBe(true);
      // and with inference on, a widget whose type matches its shape keeps it
      if (canInfer(w)) expect(sameWidget(toWidget(fromWidget(w), w, catalog, { infer: true }).widget, w)).toBe(true);
    }
  });

  it('round-trips through text', () => {
    for (const w of widgets) {
      const text = fromWidget(w).map(chipText).join(' · ');
      expect(sameWidget(toWidget(chips(text), w, catalog).widget, w)).toBe(true);
    }
  });

  it('shows the default period unless asked not to', () => {
    expect(fromWidget(W({ metrics: ['revenue'] }))).toContainEqual({ kind: 'period', value: 'last_30_days' });
    expect(fromWidget(W({ metrics: ['revenue'] }), { period: false }).some((c) => c.kind === 'period')).toBe(false);
    // a default period chip doesn't write an explicit period
    expect(toWidget(chips('revenue over time last 30 days vs previous'), W({}), catalog).widget.period).toBeUndefined();
  });

  it('shows no shape for a widget without metrics (the fresh query view, the entry box)', () => {
    expect(fromWidget(emptyExploreWidget(), { period: false })).toEqual([]);
    const entry = toWidget(chips('revenue by order__status top 5'), emptyExploreWidget(), catalog, { infer: true }).widget;
    expect(entry).toMatchObject({ type: 'leaderboard', options: { dimension: 'order__status', top_n: 5 } });
  });

  it('infers the type from the shape', () => {
    expect(inferType(chips('revenue over time'))).toBe('timeseries');
    expect(inferType(chips('revenue by region'))).toBe('bar');
    expect(inferType(chips('revenue by region top 5'))).toBe('leaderboard');
    expect(inferType(chips('revenue orders by region top 5'))).toBe('bar');
    expect(inferType(chips('revenue'))).toBe('summary');
    const fresh = emptyExploreWidget();
    const bar = toWidget(chips('revenue by region top 5 where tier = gold'), fresh, catalog, { infer: true }).widget;
    expect(bar).toMatchObject({ type: 'leaderboard', metrics: ['revenue'], options: { dimension: 'customer__region', top_n: 5 },
      filters: ["{{ Dimension('customer__tier') }} = 'gold'"], height: EXPLORE_HEIGHT });
  });

  it('never overrides a type picked in Configure', () => {
    const table = W({ type: 'table', metrics: ['revenue'], options: { dimensions: ['customer__region'] } });
    expect(canInfer(table)).toBe(false);
    const bar = W({ type: 'bar', metrics: ['revenue'], options: { dimension: 'customer__region', top_n: 5 } }); // would infer leaderboard
    expect(canInfer(bar)).toBe(false);
    expect(canInfer(W({ type: 'bar', metrics: ['revenue'], options: { dimension: 'customer__region' } }))).toBe(true);
    expect(canInfer(W({ type: 'summary', metrics: [] }))).toBe(true);
  });

  it('flags chips the type cannot hold instead of dropping them', () => {
    const summary = W({ type: 'summary', metrics: ['revenue'] });
    const out = toWidget(chips('revenue by region over time'), summary, catalog);
    expect(out.errors.map((e) => e.index)).toEqual([1, 2]);
    const leader = W({ type: 'leaderboard', metrics: ['revenue'], options: { dimension: 'customer__region' } });
    expect(toWidget(chips('revenue by region, tier'), leader, catalog).errors).toEqual([{ index: 2, message: expect.stringContaining('ranks one dimension') }]);
    expect(toWidget(chips('revenue orders'), leader, catalog).errors).toEqual([{ index: 1, message: expect.stringContaining('up to 1 metric') }]);
    expect(toWidget(chips('revenue top 5'), W({ type: 'timeseries' }), catalog).errors[0].message).toContain('needs a "by"');
  });

  it('flags a dimension the metrics do not share, and drafts', () => {
    const out = toWidget(chips('aov by status foo'), W({ type: 'bar' }), catalog);
    expect(out.errors).toEqual([
      { index: 1, message: "aov can't be broken down by order__status" },
      { index: 2, message: expect.any(String) },
    ]);
  });

  it('leaves the period alone when the line has none (the entry box)', () => {
    const w = W({ period: { current: 'last_7_days' } });
    expect(toWidget(chips('revenue'), w, catalog).widget.period).toEqual({ current: 'last_7_days' });
    expect(toWidget(chips('revenue 2025'), w, catalog).widget.period).toEqual({ current: { start: '2025-01-01', end: '2025-12-31' } });
  });
});

describe('mergeChips', () => {
  it('replaces a single-kind chip in place and skips repeats', () => {
    const merged = mergeChips(chips('revenue last 30 days vs previous'), chips('orders vs last year revenue 2025'));
    expect(merged).toEqual([
      { kind: 'metric', name: 'revenue' },
      { kind: 'period', value: { start: '2025-01-01', end: '2025-12-31' } },
      { kind: 'compare', value: 'previous_year' },
      { kind: 'metric', name: 'orders' },
    ]);
    expect(isComplete(parse('revenue by region', index))).toBe(true);
    expect(isComplete(parse('revenue by', index))).toBe(false);
    expect(isComplete(parse('revenue xyz', index))).toBe(false);
  });
});

describe('chip text', () => {
  it('labels chips', () => {
    expect(chips('revenue by region over time last 90 days vs last year no comparison top 3 where tier = gold').map((c) => chipLabel(c, labels))).toEqual([
      'Revenue', 'by customer__region', 'over time', 'Last 90 days', 'vs same period last year', 'no comparison', 'top 3', "where customer__tier = 'gold'",
    ]);
  });

  it('knows which chips can be edited as text', () => {
    for (const c of chips("revenue by region by month 2025 vs previous where region in (US, 'New Zealand') top 4")) {
      expect(editableAsText(c, index, TODAY)).toBe(true);
    }
    const advanced: Chip = { kind: 'filter', where: "{{ Dimension('customer__region') }} = 'US' OR {{ Dimension('customer__tier') }} = 'gold'" };
    expect(editableAsText(advanced, index, TODAY)).toBe(false);
  });
});

describe('suggest', () => {
  const s = (input: string, prior: Chip[] = []) => suggest(input, prior, index);
  it('offers metrics first on an empty line, keywords first once there is one', () => {
    expect(s('').items[0].kind).toBe('metric');
    expect(s('', chips('revenue')).items[0].kind).toBe('keyword');
    expect(s('rev').items[0]).toMatchObject({ kind: 'metric', insert: 'revenue' });
    // by label, fuzzy
    expect(s('count').items[0]).toMatchObject({ insert: 'orders' });
    // already picked metrics aren't offered again
    expect(s('revenue ').items.some((i) => i.insert === 'revenue')).toBe(false);
  });

  it('offers what the metrics share after by', () => {
    const items = s('aov by ').items.map((i) => i.insert);
    expect(items).toContain('customer__region');
    expect(items).not.toContain('order__status');
    expect(items).toContain('month');
    expect(s('revenue by reg')).toMatchObject({ from: 11, items: [{ insert: 'customer__region' }] });
  });

  it('walks a filter: dimension, operator, value', () => {
    expect(s('where ti').items[0].insert).toBe('customer__tier');
    expect(s('where tier ').items.map((i) => i.insert)).toContain('in');
    expect(s('where tier = go')).toEqual({ from: 13, items: [], values: { dimension: 'customer__tier', partial: 'go' } });
    expect(s("where tier = 'New Y").values).toEqual({ dimension: 'customer__tier', partial: 'New Y' });
  });

  it('completes multi-word phrases across the last words', () => {
    expect(s('revenue last 9')).toMatchObject({ from: 8, items: [{ insert: 'last 90 days' }] });
    expect(s('revenue vs ').items.map((i) => i.insert)).toEqual(['previous period', 'last year', 'nothing']);
    expect(s('top ').items[0].kind).toBe('number');
  });

  it('quotes values that need it', () => {
    expect(valueInsert('gold')).toBe('gold');
    expect(valueInsert('New Zealand')).toBe("'New Zealand'");
    expect(valueInsert("O'Brien")).toBe(`"O'Brien"`);
    expect(valueSuggestions(['gold', 'silver', 'Golden'], 'gol').map((v) => v.label)).toEqual(['gold', 'Golden']);
  });
});
