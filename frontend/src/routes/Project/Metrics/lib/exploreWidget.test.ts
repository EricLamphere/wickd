import { describe, expect, it } from 'vitest';
import type { DashboardWidget, WidgetResultDto } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import {
  clearExplore, EXPLORE_HEIGHT, exploreFromDashboard, explorePeriod, isExploreView, mainQuery, readExploreWidget, savedQueryBody,
  widgetFromLegacy, withExplorePeriod, writeExploreWidget,
} from './exploreWidget';

const catalog = {
  metrics: [{ name: 'revenue', label: null, description: null, type: 'simple', semantic_models: ['orders'], dimensions: [
    { name: 'metric_time__day', type: 'time', time_granularity: 'day', label: null, description: null },
    { name: 'customer__region', type: 'categorical', time_granularity: null, label: null, description: null },
  ] }],
  saved_queries: [],
} as unknown as SemanticCatalogDto;

describe('exploreWidget', () => {
  it('round-trips the widget through the URL, dropping older keys and the metric page', () => {
    const start = new URLSearchParams('tab=explore&metric=revenue&metrics=revenue');
    const widget: DashboardWidget = { id: 'x', type: 'bar', width: 50, height: 300, metrics: ['revenue'], options: { dimension: 'customer__region' } };
    const params = writeExploreWidget(start, widget);
    expect(params.get('tab')).toBe('explore');
    expect(params.has('metric')).toBe(false);
    expect(params.has('metrics')).toBe(false);
    expect(isExploreView(params)).toBe(true);
    expect(readExploreWidget(params)).toEqual({ ...widget, id: 'explore', width: 100, height: EXPLORE_HEIGHT });
    const back = clearExplore(params);
    expect(isExploreView(back)).toBe(false);
    expect(readExploreWidget(back)).toBeNull();
  });

  it('tells the query view from the index', () => {
    expect(isExploreView(new URLSearchParams('tab=explore'))).toBe(false);
    expect(isExploreView(new URLSearchParams('tab=explore&metrics=revenue'))).toBe(true);
    expect(isExploreView(new URLSearchParams('tab=explore&saved=weekly'))).toBe(true);
    expect(readExploreWidget(new URLSearchParams('w=not-json'))).toBeNull();
  });

  it('turns an older explorer link into a widget', () => {
    const w = widgetFromLegacy(new URLSearchParams('metrics=revenue&group_by=metric_time,customer__region&grain=week&start=2026-01-01&end=2026-01-31'), catalog);
    expect(w).toMatchObject({ id: 'explore', type: 'timeseries', metrics: ['revenue'], options: { grain: 'week', split_by: 'customer__region' },
      period: { current: { start: '2026-01-01', end: '2026-01-31' } } });
    expect(widgetFromLegacy(new URLSearchParams(''), catalog)).toMatchObject({ type: 'timeseries', metrics: [] });
  });

  it('fills in the default period and changes one key', () => {
    const w: DashboardWidget = { id: 'explore', type: 'timeseries', width: 100, height: 1, metrics: [] };
    expect(explorePeriod(w)).toEqual({ current: 'last_30_days', compare: 'previous_period' });
    expect(withExplorePeriod(w, { compare: 'none' }).period).toEqual({ current: 'last_30_days', compare: 'none' });
  });

  it('opens a dashboard widget as it showed there', () => {
    const w: DashboardWidget = { id: 'rev', type: 'bar', width: 50, height: 300, metrics: ['revenue'], filters: ['own'], options: { dimension: 'customer__region' } };
    const ran = { metrics: ['revenue'], where: ['own', 'dash'], start: '2026-01-01', end: '2026-01-31' };
    expect(exploreFromDashboard(w, ran, 'previous_year', ['pick'])).toMatchObject({
      id: 'explore', type: 'bar', options: { dimension: 'customer__region' }, filters: ['own', 'dash', 'pick'],
      period: { current: { start: '2026-01-01', end: '2026-01-31' }, compare: 'previous_year' },
    });
    expect(exploreFromDashboard({ ...w, filters: undefined }, undefined, undefined).filters).toBeUndefined();
  });

  it('finds the main query and what a saved query keeps', () => {
    const q = (query: object) => ({ status: 'ok' as const, query, sql: null, columns: [], rows: [], truncated: false, ran_at: null, error: null });
    const result = { queries: { total: q({ metrics: ['revenue'] }), total_previous: q({}) } } as unknown as WidgetResultDto;
    expect(mainQuery(result)?.role).toBe('total');
    expect(mainQuery(undefined)).toBeNull();
    expect(savedQueryBody({ metrics: ['revenue'], group_by: ['metric_time__day'], where: [], start: 'x', limit: 5 }))
      .toEqual({ metrics: ['revenue'], group_by: ['metric_time__day'] });
  });
});
