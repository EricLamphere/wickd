// The builder's side rails float over the canvas and are resizable: drag a rail's inner edge
// (double-click resets). Widths are remembered across sessions (localStorage; the rail still
// works without it). A rail is a drop target that accepts nothing, so a metric dragged back
// onto it doesn't land on the canvas underneath.
import { useCallback, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { railWidth } from '../dashboardModel';
import { startDrag } from './drag';

export interface RailSpec {
  key: string;
  side: 'left' | 'right';
  initial: number;
  min: number;
  max: number;
}

export const METRICS_RAIL: RailSpec = { key: 'wickd:dashboard-rail-metrics', side: 'left', initial: 240, min: 180, max: 480 };
export const WIDGETS_RAIL: RailSpec = { key: 'wickd:dashboard-rail-widgets', side: 'right', initial: 300, min: 240, max: 640 };

function stored(spec: RailSpec): number {
  try {
    const n = Number(localStorage.getItem(spec.key));
    return Number.isFinite(n) && n >= spec.min && n <= spec.max ? n : spec.initial;
  } catch {
    return spec.initial;
  }
}

export function useRailWidth(spec: RailSpec) {
  const [width, setWidth] = useState(() => stored(spec));
  const save = useCallback((w: number) => {
    setWidth(w);
    try { localStorage.setItem(spec.key, String(w)); } catch { /* storage unavailable */ }
  }, [spec.key]);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const startW = width;
    let last = startW;
    startDrag(e, {
      cursor: 'col-resize',
      move: (dx) => { last = railWidth(startW, dx, spec.side, spec.min, spec.max); setWidth(last); },
      end: (commit) => { if (commit) save(last); else setWidth(startW); },
    });
  }, [width, spec, save]);
  return { width, onPointerDown, reset: () => save(spec.initial) };
}

export type Rail = ReturnType<typeof useRailWidth>;
export const RAIL_DROP_PREFIX = 'rail:';

/** A floating rail: positioned over the canvas, its width from `rail`, a drop target that refuses drops. */
export function FloatingRail({ side, rail, children }: { side: 'left' | 'right'; rail: Rail; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: `${RAIL_DROP_PREFIX}${side}` });
  return (
    <aside ref={setNodeRef} style={{ width: rail.width }} data-export-hide=""
      className={`absolute top-0 bottom-0 z-30 flex flex-col min-h-0 bg-surface-panel shadow-[0_0_24px_rgb(0_0_0/0.35)] ${
        side === 'left' ? 'left-0 border-r' : 'right-0 border-l'} border-gray-800`}>
      <RailHandle side={side} onPointerDown={rail.onPointerDown} onReset={rail.reset} />
      {children}
    </aside>
  );
}

/** The drag handle on a rail's inner edge. */
export function RailHandle({ side, onPointerDown, onReset }: { side: 'left' | 'right'; onPointerDown: (e: React.PointerEvent<HTMLElement>) => void; onReset: () => void }) {
  return (
    <div role="separator" aria-orientation="vertical" aria-label="Resize panel" title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown} onDoubleClick={onReset}
      className={`absolute top-0 bottom-0 z-10 w-1.5 cursor-col-resize hover:bg-brand-500/40 active:bg-brand-500/60 ${side === 'left' ? '-right-0.5' : '-left-0.5'}`} />
  );
}
