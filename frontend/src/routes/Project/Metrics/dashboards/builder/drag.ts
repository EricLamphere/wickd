// Pointer drags for the builder's resize handles (widget edges, the board's width, the rails).
//
// A drag must always end, even when the pointer is released outside the window, which some
// browsers (WebKit in the desktop app) don't report: it ends on pointerup / pointercancel /
// lostpointercapture, on window blur, on a move with no button held (released elsewhere), and
// Escape cancels it. Only one drag runs at a time: starting one ends any that got stuck.
// With a `scroller`, dragging near or past its edge scrolls it, and the scrolled distance
// counts toward the drag, so a widget can grow beyond what's on screen.

export interface DragOptions {
  /** called with the distance from the start (scrolling included) */
  move: (dx: number, dy: number) => void;
  /** commit = false when cancelled with Escape */
  end: (commit: boolean) => void;
  scroller?: HTMLElement | null;
  cursor?: string;
}

const EDGE_PX = 32;
const MAX_SPEED = 10;

let endActive: (() => void) | null = null;

/** Scroll speed for a pointer at `pos` relative to [start, end]: faster the further past the edge. */
export function edgeSpeed(pos: number, start: number, end: number): number {
  if (pos > end - EDGE_PX) return Math.min(MAX_SPEED, Math.ceil((pos - (end - EDGE_PX)) / 4));
  if (pos < start + EDGE_PX) return -Math.min(MAX_SPEED, Math.ceil((start + EDGE_PX - pos) / 4));
  return 0;
}

export function startDrag(e: React.PointerEvent<HTMLElement>, opts: DragOptions): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  endActive?.();
  const el = e.currentTarget;
  const pointerId = e.pointerId;
  try { el.setPointerCapture(pointerId); } catch { /* capture is best effort */ }
  const x0 = e.clientX;
  const y0 = e.clientY;
  const scroller = opts.scroller ?? null;
  const sx0 = scroller?.scrollLeft ?? 0;
  const sy0 = scroller?.scrollTop ?? 0;
  let x = x0;
  let y = y0;
  let frame = 0;
  let done = false;
  if (opts.cursor) document.body.style.cursor = opts.cursor;

  const report = () => opts.move(x - x0 + ((scroller?.scrollLeft ?? 0) - sx0), y - y0 + ((scroller?.scrollTop ?? 0) - sy0));

  const autoScroll = () => {
    frame = 0;
    if (done || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const vx = edgeSpeed(x, r.left, r.right);
    const vy = edgeSpeed(y, r.top, r.bottom);
    if (!vx && !vy) return;
    const before = [scroller.scrollLeft, scroller.scrollTop];
    scroller.scrollBy(vx, vy);
    if (scroller.scrollLeft !== before[0] || scroller.scrollTop !== before[1]) report();
    frame = requestAnimationFrame(autoScroll);
  };

  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    endActive = null;
    if (frame) cancelAnimationFrame(frame);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('lostpointercapture', onUp);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('blur', onUp);
    window.removeEventListener('keydown', onKey, true);
    try { if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId); } catch { /* already released */ }
    document.body.style.cursor = '';
    opts.end(commit);
  };

  function onMove(ev: PointerEvent) {
    if (ev.buttons === 0) { finish(true); return; } // released outside the window
    x = ev.clientX;
    y = ev.clientY;
    report();
    if (!frame) frame = requestAnimationFrame(autoScroll);
  }
  function onUp() { finish(true); }
  function onKey(ev: KeyboardEvent) {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  }

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  // Fallbacks for when capture isn't honoured
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('blur', onUp);
  window.addEventListener('keydown', onKey, true);
  endActive = () => finish(true);
}
