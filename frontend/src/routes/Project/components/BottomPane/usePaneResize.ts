import { useEffect, useRef, useState } from 'react';

const MIN_HEIGHT = 180;
const DEFAULT_HEIGHT = 280;
const MAX_HEIGHT = 800;
const COLLAPSE_THRESHOLD = 80;
const BOTTOM_PANE_HEIGHT_KEY = 'wickd:bottom-pane-height';

function readStoredHeight(): number {
  try {
    const v = localStorage.getItem(BOTTOM_PANE_HEIGHT_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= MIN_HEIGHT && n <= MAX_HEIGHT) return n;
    }
  } catch { /* storage unavailable */ }
  return DEFAULT_HEIGHT;
}

/**
 * Open state and height of a bottom pane (project pages and the home page share the
 * remembered height). Dragging the tab bar resizes it; dropping below the threshold closes it.
 */
export function usePaneResize() {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(readStoredHeight);
  const resizing = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const lastHeightRef = useRef(readStoredHeight());

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const delta = startY.current - e.clientY;
      setHeight(Math.max(0, Math.min(MAX_HEIGHT, startH.current + delta)));
    };
    const onMouseUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      setHeight((h) => {
        if (h < COLLAPSE_THRESHOLD) {
          setOpen(false);
          return lastHeightRef.current;
        }
        const clamped = Math.max(MIN_HEIGHT, h);
        lastHeightRef.current = clamped;
        try { localStorage.setItem(BOTTOM_PANE_HEIGHT_KEY, String(clamped)); } catch { /* storage unavailable */ }
        return clamped;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  /** onMouseDown for the tab bar: starts a resize unless a button/input was pressed. */
  const onBarMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input')) return;
    resizing.current = true;
    startY.current = e.clientY;
    if (open) {
      startH.current = height;
    } else {
      startH.current = 0;
      setOpen(true);
      setHeight(0);
    }
    e.preventDefault();
  };

  return { open, setOpen, height, onBarMouseDown };
}
