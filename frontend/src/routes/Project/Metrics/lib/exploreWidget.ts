// The metric explorer's query view is one widget (the dashboards' widget types and settings),
// kept in the URL as `?view=query&w=<json>` so back/forward and links work. Older links — the
// query params of lib/metricQuery.ts (Docs' Explore, ⌘K, Wicky's Query data, saved queries) —
// are turned into a widget on arrival. Pure; tested in exploreWidget.test.ts.
import type { ComparePeriod, CurrentPeriod, DashboardWidget, WidgetResultDto } from '../../../../lib/dashboardsApi';
import type { MetricQueryBody, SemanticCatalogDto } from '../../../../lib/semanticApi';
import { widgetFromQuery } from '../dashboards/dashboardModel';
import { DEFAULT_PERIOD, type MetricPeriod } from './metricPage';
import { EMPTY_STATE, groupByOptions, stateFromParams, toRequest, writeState } from './metricQuery';

export const EXPLORE_ID = 'explore';
/** The explorer draws its widget this tall (px). */
export const EXPLORE_HEIGHT = 380;

const WIDGET_PARAM = 'w';
const VIEW_PARAM = 'view';
/** lib/metricQuery.ts's URL keys: their presence means an older explorer link. */
const LEGACY_KEYS = ['metrics', 'saved', 'group_by', 'grain', 'where', 'start', 'end', 'order_by', 'limit'];

export function emptyExploreWidget(metrics: string[] = []): DashboardWidget {
  return { id: EXPLORE_ID, type: 'timeseries', width: 100, height: EXPLORE_HEIGHT, metrics };
}

/** Whether the URL asks for the query view (rather than the index or a metric page). */
export function isExploreView(params: URLSearchParams): boolean {
  return params.get(VIEW_PARAM) === 'query' || LEGACY_KEYS.some((k) => params.has(k));
}

export function readExploreWidget(params: URLSearchParams): DashboardWidget | null {
  const raw = params.get(WIDGET_PARAM);
  if (!raw) return null;
  try {
    const w = JSON.parse(raw) as Partial<DashboardWidget>;
    if (!w || typeof w !== 'object' || typeof w.type !== 'string') return null;
    return { ...emptyExploreWidget(), ...w, id: EXPLORE_ID, width: 100, height: EXPLORE_HEIGHT } as DashboardWidget;
  } catch {
    return null;
  }
}

/** `prev` showing the query view with `widget` (an older link's keys and the metric page dropped). */
export function writeExploreWidget(prev: URLSearchParams, widget: DashboardWidget): URLSearchParams {
  const next = writeState(prev, EMPTY_STATE);
  next.delete('metric');
  next.set(VIEW_PARAM, 'query');
  const { id: _id, width: _w, height: _h, ...rest } = widget;
  next.set(WIDGET_PARAM, JSON.stringify(rest));
  return next;
}

/** `prev` without the query view (back to the index). */
export function clearExplore(prev: URLSearchParams): URLSearchParams {
  const next = writeState(prev, EMPTY_STATE);
  next.delete(VIEW_PARAM);
  next.delete(WIDGET_PARAM);
  // compare mode (lib/compareView.ts) belongs to the query view
  next.delete('cmp');
  next.delete('cmp_base');
  return next;
}

/** An older explorer link's query as the explorer's widget (its type picked from the query's shape). */
export function widgetFromLegacy(params: URLSearchParams, catalog: SemanticCatalogDto): DashboardWidget {
  const state = stateFromParams(params);
  const body = toRequest(state, groupByOptions(catalog, state.metrics));
  if (!body) return emptyExploreWidget();
  return { ...widgetFromQuery(body, catalog, []), id: EXPLORE_ID, width: 100, height: EXPLORE_HEIGHT };
}

/** The widget's period with the explorer's defaults filled in (for the period pickers). */
export function explorePeriod(widget: DashboardWidget): MetricPeriod {
  return { current: widget.period?.current ?? DEFAULT_PERIOD.current, compare: widget.period?.compare ?? DEFAULT_PERIOD.compare };
}

export function withExplorePeriod(widget: DashboardWidget, period: { current?: CurrentPeriod; compare?: ComparePeriod }): DashboardWidget {
  return { ...widget, period: { ...explorePeriod(widget), ...period } };
}

/**
 * A dashboard widget opened in the explorer, as it shows on the dashboard: the query it ran
 * gives the filters that applied (its own + the dashboard's that fit) and the dates; the
 * comparison follows the widget's, else the dashboard's.
 */
export function exploreFromDashboard(widget: DashboardWidget, ran: MetricQueryBody | undefined, compare: ComparePeriod | undefined,
  extraFilters: string[] = []): DashboardWidget {
  const filters = [...(ran?.where ?? widget.filters ?? []), ...extraFilters];
  const current = ran?.start && ran.end ? { start: ran.start, end: ran.end } : widget.period?.current;
  return {
    ...widget, id: EXPLORE_ID, width: 100, height: EXPLORE_HEIGHT,
    filters: filters.length ? [...new Set(filters)] : undefined,
    period: { ...(current ? { current } : {}), ...(widget.period?.compare ?? compare ? { compare: widget.period?.compare ?? compare } : {}) },
  };
}

/** The query a result ran for its main role (current, else the summary's total). */
export function mainQuery(result: WidgetResultDto | undefined): { role: string; body: MetricQueryBody } | null {
  if (!result) return null;
  for (const role of ['current', 'total', 'trend']) {
    const q = result.queries[role];
    if (q) return { role, body: q.query };
  }
  return null;
}

/** What "Save as saved query" stores: the query's metrics, group-bys and filters (no dates). */
export function savedQueryBody(body: MetricQueryBody): MetricQueryBody {
  return {
    metrics: body.metrics ?? [],
    ...(body.group_by?.length ? { group_by: body.group_by } : {}),
    ...(body.where?.length ? { where: body.where } : {}),
  };
}
