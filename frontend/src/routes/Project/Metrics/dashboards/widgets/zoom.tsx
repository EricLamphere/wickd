// Highlighting periods on a chart over time (the time series widget and the metric summary's
// trend): the zoom state (kept by the widget frame when it passes one, so the value menu's
// Zoom to can set it, else by the chart), the Reset zoom button, and the value-menu pick for
// a right-click (the zoomed periods, or the period under the pointer). Range math in
// ../timeRange.ts.
import { useState } from 'react';
import { ZoomOut } from 'lucide-react';
import type { DateRange } from '../../../../../lib/dashboardsApi';
import type { Pick } from '../drill';
import { inRange, rangeBetween } from '../timeRange';

export interface ZoomProps {
  /** right-click: the value menu for the highlighted periods, or the period under the pointer */
  onMenu?: ((pick: Pick, x: number, y: number) => void) | null;
  /** the highlighted (zoomed) periods; with `onZoom` the parent keeps them, else the chart does */
  zoom?: DateRange | null;
  onZoom?: (range: DateRange | null) => void;
}

export interface Interaction {
  zoom: DateRange | null;
  onZoom: (range: DateRange | null) => void;
  onMenu: ZoomProps['onMenu'];
}

/** The zoom, controlled by the parent when it passes `onZoom`, else kept here. */
export function useZoom(props: ZoomProps): Interaction {
  const [local, setLocal] = useState<DateRange | null>(null);
  return {
    zoom: props.onZoom ? props.zoom ?? null : local,
    onZoom: props.onZoom ?? setLocal,
    onMenu: props.onMenu ?? null,
  };
}

/** What a right-click at period `x` picks: the zoomed periods when `x` is in them, else that period. */
export function rangePick(x: number, zoom: DateRange | null, grain: string): Pick {
  return { values: [], range: zoom && inRange(x, zoom) ? zoom : rangeBetween(x, x, grain) };
}

export function ResetZoom({ zoom, onReset }: { zoom: DateRange; onReset: () => void }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onReset(); }} title={`Zoomed to ${zoom.start} – ${zoom.end}. Show the whole period`}
      className="absolute z-10 top-0 right-1 flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-gray-700 bg-surface-elevated text-gray-300 hover:border-gray-500"
      data-export-hide="">
      <ZoomOut className="w-3 h-3" />Reset zoom
    </button>
  );
}
