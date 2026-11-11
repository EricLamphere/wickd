import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  anchorFromRect, clampAnchor, clampOffset, isDrag, isOutside, parseAnchor, shiftRect,
  type BubbleAnchor, type Offset, type Rect, type Viewport,
} from '../../lib/bubblePosition';

/** One position for every project (a per-browser convenience, so localStorage). */
const STORAGE_KEY = 'wickd:activity-bubble-position';
/** The collapsed bubble's height (and the circle's width), for keeping it on screen. */
export const BUBBLE_SIZE_PX = 30;

function readStored(): BubbleAnchor | null {
  try {
    return parseAnchor(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(anchor: BubbleAnchor | null): void {
  try {
    if (anchor) localStorage.setItem(STORAGE_KEY, JSON.stringify(anchor));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked: the position just won't survive a reload
  }
}

function useViewport(): Viewport {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [viewport, setViewport] = useState<Viewport>(read);
  useEffect(() => {
    const onResize = () => setViewport(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

interface DragStart {
  pointerId: number;
  /** holds the pointer capture from the press on */
  element: HTMLElement;
  x: number;
  y: number;
  /** set once the pointer passed the drag threshold */
  drag: { rect: Rect; offset: Offset } | null;
}

export interface BubbleDrag {
  /** null until the user drags it: the bubble sits in its default corner */
  anchor: BubbleAnchor | null;
  viewport: Viewport;
  /** live offset while dragging, applied as a transform */
  offset: Offset | null;
  /** spread onto the bubble button */
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => void;
  };
  /** true right after a drag ends, so the release isn't taken as a click */
  consumeClick: () => boolean;
  reset: () => void;
}

function windowSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Drag the bubble anywhere in the window; the drop point is remembered across reloads. The bubble
 * stops EDGE_MARGIN from the window's edges, and a pointer that leaves the window drops it there.
 */
export function useBubbleDrag(): BubbleDrag {
  const viewport = useViewport();
  const [stored, setStored] = useState<BubbleAnchor | null>(readStored);
  const [offset, setOffset] = useState<Offset | null>(null);
  // While dragging out of the default corner: the same spot as a window anchor, so the bubble
  // leaves the page area (which clips overflow) and can cross the header.
  const [dragFrom, setDragFrom] = useState<BubbleAnchor | null>(null);
  const start = useRef<DragStart | null>(null);
  const suppressClick = useRef(false);

  /** Ends the press; a drag drops where the (clamped) bubble is now, unless cancelled. */
  const finish = useCallback((commit: boolean) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    if (s.element.hasPointerCapture(s.pointerId)) s.element.releasePointerCapture(s.pointerId);
    if (!s.drag) return;
    const { rect, offset: last } = s.drag;
    suppressClick.current = true;
    if (commit) {
      const anchor = anchorFromRect(shiftRect(rect, last), windowSize());
      setStored(anchor);
      writeStored(anchor);
    }
    setOffset(null);
    setDragFrom(null);
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // a drag's release may or may not be followed by a click: never let a stale flag eat this one
    suppressClick.current = false;
    // Capture now, not at the drag threshold: a quick flick leaves the 30px bubble before the
    // threshold is reached, and the release would then land elsewhere and never end the press.
    const element = e.currentTarget;
    element.setPointerCapture(e.pointerId);
    start.current = { pointerId: e.pointerId, element, x: e.clientX, y: e.clientY, drag: null };
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || s.pointerId !== e.pointerId) return;
    // the button came up somewhere we didn't hear about: the press is over
    if ((e.buttons & 1) === 0) {
      finish(true);
      return;
    }
    const raw = { x: e.clientX - s.x, y: e.clientY - s.y };
    if (!s.drag) {
      if (!isDrag(raw.x, raw.y)) return;
      const rect = s.element.getBoundingClientRect();
      s.drag = { rect, offset: { x: 0, y: 0 } };
      setDragFrom(anchorFromRect(rect, windowSize()));
    }
    const size = windowSize();
    s.drag.offset = clampOffset(s.drag.rect, raw, size);
    // past the window's edge: drop it at the edge and let go
    if (isOutside(e.clientX, e.clientY, size)) {
      finish(true);
      return;
    }
    setOffset(s.drag.offset);
  }, [finish]);

  // Browsers that stop reporting a captured pointer outside the window still fire these.
  useEffect(() => {
    if (!offset) return;
    const drop = () => finish(true);
    const onLeave = (e: MouseEvent) => {
      if (e.relatedTarget === null) drop();
    };
    document.documentElement.addEventListener('mouseleave', drop);
    document.addEventListener('mouseout', onLeave);
    window.addEventListener('blur', drop);
    return () => {
      document.documentElement.removeEventListener('mouseleave', drop);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('blur', drop);
    };
  }, [offset !== null, finish]); // eslint-disable-line react-hooks/exhaustive-deps

  const consumeClick = useCallback(() => {
    const was = suppressClick.current;
    suppressClick.current = false;
    return was;
  }, []);

  const reset = useCallback(() => {
    setStored(null);
    writeStored(null);
  }, []);

  const placed = stored ?? dragFrom;
  return {
    anchor: placed ? clampAnchor(placed, viewport, BUBBLE_SIZE_PX) : null,
    viewport,
    offset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e) => { if (start.current?.pointerId === e.pointerId) finish(true); },
      onPointerCancel: (e) => { if (start.current?.pointerId === e.pointerId) finish(false); },
      // capture taken away (element re-rendered away, browser quirk): treat as the release
      onLostPointerCapture: (e) => { if (start.current?.pointerId === e.pointerId) finish(true); },
    },
    consumeClick,
    reset,
  };
}
