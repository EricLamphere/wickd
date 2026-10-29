import { describe, expect, it } from 'vitest';
import type { DashboardDoc, DashboardWidget } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import {
  addMetric, alignPrevious, canvasWidthOf, orderWidgets, placeWidget, widthLockLines, changeType, clampCanvasWidth, querySignature, signatures, railWidth, requiredRole, categories, changeRatio, changeTone, currentLabel, duplicateWidget, filterFor, formatChange,
  formatMetric, historyOf, insertWidget, monitorForWidget, moveWidget, newWidget, newWidgetId, overlayFromPoints, rangeLabel,
  pxToWidth, record, redo, removeMetric, resized, resolveCompare, snapHeight, snapWidth, widthCss, widthToPx, resolveCurrent, separateCharts, series, sortCategories, toCsv, undo, widgetFromQuery,
  withDashboardFilter, withOption,
} from './dashboardModel';

const dim = (name: string, type = 'categorical', grain: string | null = null) =>
  ({ name, type, time_granularity: grain, label: null, description: null });
const CATALOG = {
  metrics: [
    { name: 'revenue', label: 'Revenue', description: null, type: 'simple', semantic_models: [],
      dimensions: [dim('metric_time__day', 'time', 'day'), dim('customer__region'), dim('order__channel')] },
    { name: 'orders', label: null, description: null, type: 'simple', semantic_models: [],
      dimensions: [dim('metric_time__day', 'time', 'day'), dim('customer__region')] },
  ],
  saved_queries: [{ name: 'weekly', label: null, description: null, metrics: ['revenue'],
    group_by: ["TimeDimension('metric_time', 'week')", "Dimension('order__channel')"], where: ['x = 1'] }],
} as unknown as SemanticCatalogDto;

const doc = (widgets: DashboardWidget[]): DashboardDoc => ({ version: 1, title: 'D', widgets });
const w = (id: string, extra: Partial<DashboardWidget> = {}): DashboardWidget => ({ id, type: 'summary', width: 25, height: 200, metrics: ['revenue'], ...extra });

describe('widgets', () => {
  it('creates widgets with type defaults', () => {
    expect(newWidget('summary', [], ['revenue'], CATALOG)).toEqual({ id: 'revenue', type: 'summary', width: 25, height: 200, metrics: ['revenue'] });
    expect(newWidget('bar', ['revenue'], ['revenue'], CATALOG)).toMatchObject({ id: 'revenue_2', width: 50, options: { dimension: 'customer__region' } });
    expect(newWidget('text', [], [], CATALOG)).toMatchObject({ metrics: [], width: 100, height: 90, options: { body: '## Section' } });
    expect(newWidget('leaderboard', [], ['revenue', 'orders'], CATALOG).metrics).toEqual(['revenue']);
    expect(newWidgetId('Revenue by Region!', [])).toBe('revenue_by_region');
  });

  it('adds metrics within each type\'s rules', () => {
    expect(addMetric(w('a'), 'orders', CATALOG).widget?.metrics).toEqual(['revenue', 'orders']);
    expect(addMetric(w('a'), 'revenue', CATALOG).error).toBe('revenue is already here');
    expect(addMetric(w('a', { type: 'leaderboard' }), 'orders', CATALOG).error).toBe('Top N shows one metric');
    expect(addMetric(w('a', { type: 'text', metrics: [] }), 'orders', CATALOG).error).toMatch(/don't show metrics/);
    expect(addMetric(w('a', { type: 'bar', options: { dimension: 'order__channel' } }), 'orders', CATALOG).error)
      .toBe("orders can't be broken down by order__channel");
    expect(addMetric(w('a', { type: 'bar', metrics: [] }), 'orders', CATALOG).widget?.options).toEqual({ dimension: 'customer__region' });
    expect(removeMetric(w('a', { metrics: ['revenue', 'orders'] }), 'revenue').metrics).toEqual(['orders']);
  });

  it('sets and clears options', () => {
    const a = withOption(w('a'), 'format', 'currency');
    expect(a.options).toEqual({ format: 'currency' });
    expect(withOption(a, 'format', '').options).toEqual({});
  });

  it('maps explorer queries to widgets', () => {
    expect(widgetFromQuery({ metrics: ['revenue'] }, CATALOG, [])).toMatchObject({ type: 'summary', metrics: ['revenue'] });
    expect(widgetFromQuery({ metrics: ['revenue'], group_by: ['metric_time__week', 'order__channel'], where: ['y'],
      start: '2026-01-01', end: '2026-01-31' }, CATALOG, [])).toMatchObject({
      type: 'timeseries', filters: ['y'], period: { current: { start: '2026-01-01', end: '2026-01-31' } },
      options: { grain: 'week', split_by: 'order__channel' } });
    expect(widgetFromQuery({ metrics: ['revenue'], group_by: ['customer__region', 'order__channel'] }, CATALOG, []))
      .toMatchObject({ type: 'bar', options: { dimension: 'customer__region', stack_by: 'order__channel' } });
    expect(widgetFromQuery({ saved_query: 'weekly' }, CATALOG, [])).toMatchObject({
      type: 'timeseries', metrics: ['revenue'], filters: ['x = 1'], options: { grain: 'week', split_by: 'order__channel' } });
  });
});

describe('layout', () => {
  const d = doc([w('a'), w('b'), w('c')]);
  it('inserts, moves and duplicates without mutating', () => {
    expect(insertWidget(d, w('x'), 1).widgets.map((x) => x.id)).toEqual(['a', 'x', 'b', 'c']);
    expect(insertWidget(d, w('x')).widgets.at(-1)?.id).toBe('x');
    expect(moveWidget(d, 0, 2).widgets.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(moveWidget(d, 0, 9)).toBe(d);
    expect(duplicateWidget(d, 'b').widgets.map((x) => x.id)).toEqual(['a', 'b', 'b_2', 'c']);
    expect(orderWidgets(d, ['c', 'x', 'a']).widgets.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(placeWidget(['a', 'b', 'c', 'd'], 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd']);
    expect(placeWidget(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(placeWidget(['a', 'b', 'c', 'd'], 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c']);
    expect(placeWidget(['a', 'b'], 'a', 'a', true)).toEqual(['a', 'b']);
    expect(d.widgets.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('converts widths between percent and px (gaps included)', () => {
    expect(widthToPx(50, 1000)).toBeCloseTo(494);
    expect(pxToWidth(widthToPx(37.5, 1000), 1000)).toBeCloseTo(37.5);
    expect(widthToPx(100, 1000)).toBeCloseTo(1000);
    expect(widthCss(50)).toBe('calc(50% - 6px)');
    expect(widthCss(500)).toBe('calc(100% - 0px)');
  });

  it('locks widths to quarters, the rest of the row and every 100 px, never past the row', () => {
    // a 1200 px board: a quarter is 291 px wide (gaps included), 100 px is 9.24%
    expect(snapWidth(23.5, 1200)).toEqual({ value: 25, locked: true });
    expect(snapWidth(9, 1200)).toEqual({ value: 9.24, locked: true });
    expect(snapWidth(17.0, 1200)).toEqual({ value: 17.49, locked: true }); // 200 px
    expect(snapWidth(13.0, 1200)).toEqual({ value: 13, locked: false });
    expect(snapWidth(1, 1200)).toEqual({ value: 5, locked: false });
    expect(snapWidth(90, 1200, 66.4)).toEqual({ value: 66.4, locked: true });
    expect(snapWidth(60, 1200, 66.4).locked).toBe(false);
  });

  it('locks a widget\'s right edge to the dashboard\'s grid, wherever it starts', () => {
    // starts 350 px in: 245 px wide puts its edge at 595 (the 50% line, 594 px) → 244 px
    expect(snapWidth(pxToWidth(245, 1200), 1200, 100, 350)).toEqual({ value: +pxToWidth(244, 1200).toFixed(2), locked: true });
    // 445 px wide puts its edge at 795 → the 800 px grid line → 450 px
    expect(snapWidth(pxToWidth(445, 1200), 1200, 100, 350)).toEqual({ value: +pxToWidth(450, 1200).toFixed(2), locked: true });
    const lines = widthLockLines(1200);
    expect(lines.filter((l) => l.kind === 'grid').map((l) => l.x)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
    expect(lines.filter((l) => l.kind === 'quarter').map((l) => l.x)).toEqual([291, 594, 897]);
    expect(lines.at(-1)).toEqual({ x: 1200, kind: 'edge' });
  });

  it('locks heights to 100 px and to row neighbours', () => {
    expect(snapHeight(207)).toEqual({ value: 200, locked: true });
    expect(snapHeight(243)).toEqual({ value: 244, locked: false });
    expect(snapHeight(243, [240])).toEqual({ value: 240, locked: true });
    expect(snapHeight(10)).toEqual({ value: 60, locked: false });
  });

  it('resizes within the limits', () => {
    const start = { width: 25, height: 200 };
    expect(resized(start, 0, 37, 1000, { x: false, y: true })).toEqual({ width: 25, height: 236, locked: { x: false, y: false } });
    expect(resized(start, 252, 0, 1000, { x: true, y: false })).toMatchObject({ width: 50, locked: { x: true } });
    expect(resized(start, 155, 0, 1000, { x: true, y: false })).toMatchObject({ width: 40.71, locked: { x: true } }); // 241 px + 155 → 400 px
    expect(resized(start, 5000, 5000, 1000, { x: true, y: true }, { maxWidth: 60 })).toEqual({ width: 60, height: 2000, locked: { x: true, y: true } });
  });
});

describe('history', () => {
  it('undoes and redoes', () => {
    let h = historyOf(1);
    h = record(record(h, 2), 3);
    expect(undo(h).present).toBe(2);
    expect(redo(undo(h)).present).toBe(3);
    expect(record(undo(h), 9).future).toEqual([]);
    expect(undo(historyOf(1)).present).toBe(1);
    expect(record(h, 3)).toBe(h);
  });
});

describe('periods', () => {
  it('labels ranges compactly', () => {
    expect(rangeLabel({ start: '2026-03-01', end: '2026-03-31' })).toBe('Mar 1 – 31, 2026');
    expect(rangeLabel({ start: '2026-02-03', end: '2026-03-02' })).toBe('Feb 3 – Mar 2, 2026');
    expect(rangeLabel({ start: '2025-12-01', end: '2026-01-04' })).toBe('Dec 1, 2025 – Jan 4, 2026');
    expect(rangeLabel(null)).toBe('All time');
    expect(currentLabel('month_to_date')).toBe('Month to date');
  });
});

describe('shaping results', () => {
  it('aligns the previous period under the current one by index', () => {
    const cur = series(['t', 'm'], [['2026-03-02', 2], ['2026-03-01', 1], ['2026-03-03', 3]], 'm', 't');
    expect(cur.map((p) => p.v)).toEqual([1, 2, 3]);
    const prev = series(['t', 'm'], [['2026-02-01', 10], ['2026-02-02', 20]], 'm', 't');
    expect(alignPrevious(cur, prev)).toEqual([10, 20, null]);
  });

  it('splits charts when scales differ 10× (auto)', () => {
    expect(separateCharts([100, 5], 'auto')).toBe(true);
    expect(separateCharts([100, 50], 'auto')).toBe(false);
    expect(separateCharts([100, 5], 'combined')).toBe(false);
    expect(separateCharts([100, 50], 'separate')).toBe(true);
    expect(separateCharts([100], 'separate')).toBe(false);
  });

  it('computes and colours changes', () => {
    expect(changeRatio(150, 100)).toBeCloseTo(0.5);
    expect(changeRatio(1, 0)).toBeNull();
    expect(changeTone(0.2, true)).toBe('good');
    expect(changeTone(0.2, false)).toBe('bad');
    expect(changeTone(0, true)).toBe('flat');
    expect(formatChange(-0.034)).toBe('−3.4%');
  });

  it('formats values', () => {
    expect(formatMetric(1234.5, { format: 'currency' })).toMatch(/\$1,234\.5/);
    expect(formatMetric(0.123, { format: 'percent' })).toBe('12.3%');
    expect(formatMetric(25_000, {}, true)).toBe('25K');
    expect(formatMetric(null)).toBe('–');
    expect(formatMetric(5, { format: 'currency', currency: 'XX' })).toBe('5');
  });

  it('joins categories with their previous values', () => {
    const cur = { columns: ['r', 'm'], rows: [['n', 5], ['s', 9], [null, 1]] };
    const prev = { columns: ['r', 'm'], rows: [['s', 3], ['e', 7]] };
    const cats = categories(cur, prev, 'r', 'm');
    expect(cats).toEqual([{ key: 'n', value: 5, previous: null }, { key: 's', value: 9, previous: 3 }, { key: '∅', value: 1, previous: null }]);
    expect(sortCategories(cats, 'value').map((c) => c.key)).toEqual(['s', 'n', '∅']);
    expect(sortCategories(cats, 'name').map((c) => c.key)).toEqual(['n', 's', '∅']);
    expect(categories(cur, null, 'r', 'm')[1].previous).toBeNull();
  });

  it('builds click-to-filter filters', () => {
    expect(filterFor('customer__region', 'north')).toBe("{{ Dimension('customer__region') }} = 'north'");
    expect(filterFor('customer__region', '∅')).toBe("{{ Dimension('customer__region') }} is null");
    const d = withDashboardFilter(doc([]), 'x');
    expect(withDashboardFilter(d, 'x')).toBe(d);
  });

  it('writes CSV', () => {
    expect(toCsv(['a', 'b'], [['x,y', null]])).toBe('a,b\n"x,y",');
  });
});

describe('monitor overlay', () => {
  const monitor = (over: object) => ({ id: 1, metric: 'revenue', grain: 'day', dimension: null, enabled: true, ...over }) as never;
  const ts = w('a', { type: 'timeseries' });
  it('matches an unsliced monitor on an unfiltered single-metric time series', () => {
    expect(monitorForWidget([monitor({})], ts, 'day', false)).toMatchObject({ id: 1 });
    expect(monitorForWidget([monitor({})], ts, 'day', true)).toBeNull();
    expect(monitorForWidget([monitor({ grain: 'week' })], ts, 'day', false)).toBeNull();
    expect(monitorForWidget([monitor({})], w('a'), 'day', false)).toBeNull();
  });
  it('builds the band and flagged points', () => {
    const p = (period: string, kind: string, extra: object = {}) =>
      ({ period, value: 1, expected: 1, low: 0, high: 2, kind, partial: false, ...extra }) as never;
    const o = overlayFromPoints([p('2026-10-01', 'none'), p('2026-10-02', 'anomaly'), p('2026-10-03', 'warn', { partial: true })]);
    expect(o.band.size).toBe(3);
    expect(o.flagged).toEqual([{ x: Date.UTC(2026, 9, 2), tone: 'fail' }]);
  });
});

describe('period resolution (mirrors the backend)', () => {
  const today = new Date(2026, 9, 28);
  it.each([
    ['last_7_days', '2026-10-22', '2026-10-28'],
    ['last_30_days', '2026-09-29', '2026-10-28'],
    ['last_12_months', '2025-10-29', '2026-10-28'],
    ['month_to_date', '2026-10-01', '2026-10-28'],
    ['quarter_to_date', '2026-10-01', '2026-10-28'],
    ['year_to_date', '2026-01-01', '2026-10-28'],
    ['last_month', '2026-09-01', '2026-09-30'],
    ['last_quarter', '2026-07-01', '2026-09-30'],
  ] as const)('%s', (preset, start, end) => {
    expect(resolveCurrent(preset, today)).toEqual({ start, end });
  });

  it('resolves comparisons', () => {
    const cur = resolveCurrent('last_month', today);
    expect(resolveCompare('previous_period', cur)).toEqual({ start: '2026-08-02', end: '2026-08-31' });
    expect(resolveCompare('previous_year', cur)).toEqual({ start: '2025-09-01', end: '2025-09-30' });
    expect(resolveCompare('none', cur)).toBeNull();
    expect(resolveCurrent('all_time', today)).toBeNull();
    expect(resolveCompare('previous_year', { start: '2028-02-29', end: '2028-02-29' })).toEqual({ start: '2027-02-28', end: '2027-02-28' });
  });
});

describe('type changes and rails', () => {
  it('changes type, keeping what fits', () => {
    const sum = w('a', { metrics: ['revenue', 'orders'], options: { format: 'currency' } });
    expect(changeType(sum, 'leaderboard', CATALOG)).toMatchObject({ type: 'leaderboard', metrics: ['revenue'],
      options: { format: 'currency', dimension: 'customer__region' } });
    expect(changeType(sum, 'text', CATALOG)).toMatchObject({ metrics: [], options: { body: '## Section' } });
    expect(changeType(changeType(sum, 'text', CATALOG), 'summary', CATALOG).options).toEqual({});
    expect(changeType(sum, 'summary', CATALOG)).toBe(sum);
    expect(requiredRole('summary')).toBe('total');
    expect(requiredRole('leaderboard')).toBe('current');
    expect(requiredRole('text')).toBeNull();
  });
  it('clamps rail widths', () => {
    expect(railWidth(240, 60, 'left', 180, 480)).toBe(300);
    expect(railWidth(288, 60, 'right', 240, 640)).toBe(240);
    expect(railWidth(288, -500, 'right', 240, 640)).toBe(640);
  });
});

describe('canvas width', () => {
  it('defaults and clamps', () => {
    expect(canvasWidthOf({})).toBe(1200);
    expect(canvasWidthOf({ canvas_width: 1444 })).toBe(1440);
    expect(clampCanvasWidth(100)).toBe(480);
    expect(clampCanvasWidth(99999)).toBe(4000);
  });
});

describe('result signatures', () => {
  const d = doc([w('a'), w('b', { type: 'text', metrics: [] })]);
  it('changes with query settings, not with title or size', () => {
    const base = querySignature(d, d.widgets[0]);
    expect(querySignature(d, { ...d.widgets[0], title: 'X', width: 90, height: 500 })).toBe(base);
    expect(querySignature(d, { ...d.widgets[0], options: { trend: false } })).not.toBe(base);
    expect(querySignature(d, { ...d.widgets[0], options: { format: 'currency', higher_is_better: false } })).toBe(base);
    expect(querySignature(d, { ...d.widgets[0], options: { show_change: false } })).not.toBe(base);
    const bar = w('c', { type: 'bar', options: { dimension: 'a' } });
    expect(querySignature(d, { ...bar, options: { dimension: 'a', orientation: 'horizontal', sort: 'name' } })).toBe(querySignature(d, bar));
    expect(querySignature(d, { ...bar, options: { dimension: 'b' } })).not.toBe(querySignature(d, bar));
    expect(querySignature({ ...d, period: { current: 'last_7_days', compare: 'none' } }, d.widgets[0])).not.toBe(base);
    expect(querySignature(d, d.widgets[1])).toBe('text');
    expect(Object.keys(signatures(d, ['a']))).toEqual(['a']);
    expect(signatures(null)).toEqual({});
  });

});
