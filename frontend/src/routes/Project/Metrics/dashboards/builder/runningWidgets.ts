// Which dashboard widgets a Run / Refresh is in flight for. Each run is tracked on its own:
// a single "running" value let one run finishing clear another's spinner (a widget added while
// others were refreshing then showed Run although its own run was still queued). Pure.

export interface WidgetRun {
  id: number;
  /** null = every widget (Refresh all) */
  widgetIds: readonly string[] | null;
}

export type WidgetRuns = readonly WidgetRun[];

export const NO_RUNS: WidgetRuns = [];

let lastId = 0;

/** A new run's id (taken before the state update, so the caller always has it). */
export function newRunId(): number {
  lastId += 1;
  return lastId;
}

/** The runs with run `id` added for `widgetIds` (undefined = all). */
export function startRun(runs: WidgetRuns, id: number, widgetIds: readonly string[] | undefined): WidgetRuns {
  return [...runs, { id, widgetIds: widgetIds ? [...widgetIds] : null }];
}

export function endRun(runs: WidgetRuns, id: number): WidgetRuns {
  return runs.filter((r) => r.id !== id);
}

export function isRunning(runs: WidgetRuns, widgetId: string): boolean {
  return runs.some((r) => r.widgetIds === null || r.widgetIds.includes(widgetId));
}

export function anyRunning(runs: WidgetRuns): boolean {
  return runs.length > 0;
}
