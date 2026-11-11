// Where the running-status bubble sits once the user drags it (plan 29). Pure; tested in
// bubblePosition.test.ts. Undragged, the bubble keeps its default spot (bottom right of the page
// area) and none of this applies.

/**
 * A dragged position, anchored to the nearest viewport corner so the bubble grows away from the
 * edge it's near (a pill widening, the panel opening) and stays put when the window resizes.
 */
export interface BubbleAnchor {
  horizontal: 'left' | 'right';
  /** px from the anchored side to the bubble's edge */
  x: number;
  vertical: 'top' | 'bottom';
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Keeps a bubble this far from the window edges. */
export const EDGE_MARGIN = 8;
/** A pointer move shorter than this is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4;

/** The anchor for a bubble dropped at `rect`: the corner its center is nearest to. */
export function anchorFromRect(rect: Rect, viewport: Viewport): BubbleAnchor {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const horizontal = centerX < viewport.width / 2 ? 'left' : 'right';
  const vertical = centerY < viewport.height / 2 ? 'top' : 'bottom';
  return {
    horizontal,
    x: Math.round(horizontal === 'left' ? rect.left : viewport.width - rect.right),
    vertical,
    y: Math.round(vertical === 'top' ? rect.top : viewport.height - rect.bottom),
  };
}

/** Keeps a bubble of `size` px on screen (e.g. after the window shrank). */
export function clampAnchor(anchor: BubbleAnchor, viewport: Viewport, size: number): BubbleAnchor {
  const clamp = (v: number, extent: number) =>
    Math.min(Math.max(v, EDGE_MARGIN), Math.max(EDGE_MARGIN, extent - size - EDGE_MARGIN));
  return { ...anchor, x: clamp(anchor.x, viewport.width), y: clamp(anchor.y, viewport.height) };
}

/** Whether a pointer that moved (dx, dy) since pressing is dragging. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}

/** Reads a stored anchor; anything malformed reads as "not dragged". */
export function parseAnchor(raw: string | null): BubbleAnchor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BubbleAnchor>;
    const ok = (v.horizontal === 'left' || v.horizontal === 'right')
      && (v.vertical === 'top' || v.vertical === 'bottom')
      && typeof v.x === 'number' && Number.isFinite(v.x)
      && typeof v.y === 'number' && Number.isFinite(v.y);
    return ok ? (v as BubbleAnchor) : null;
  } catch {
    return null;
  }
}

export interface Offset {
  x: number;
  y: number;
}

/**
 * Limits a drag offset so the bubble that started at `rect` stays EDGE_MARGIN inside the window:
 * the pointer can keep going, the bubble stops at the edge.
 */
export function clampOffset(rect: Rect, offset: Offset, viewport: Viewport): Offset {
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));
  return {
    x: clamp(offset.x, EDGE_MARGIN - rect.left, viewport.width - EDGE_MARGIN - rect.right),
    y: clamp(offset.y, EDGE_MARGIN - rect.top, viewport.height - EDGE_MARGIN - rect.bottom),
  };
}

/** `rect` moved by `offset`. */
export function shiftRect(rect: Rect, offset: Offset): Rect {
  return {
    left: rect.left + offset.x, right: rect.right + offset.x,
    top: rect.top + offset.y, bottom: rect.bottom + offset.y,
  };
}

/** Whether a pointer at (x, y) is past the window's edge (a captured pointer keeps reporting there). */
export function isOutside(x: number, y: number, viewport: Viewport): boolean {
  return x < 0 || y < 0 || x >= viewport.width || y >= viewport.height;
}
