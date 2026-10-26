import { useEffect, useRef, useState } from 'react';

const PANE_MIN = 280;
const PANE_DEFAULT = 520;
const PANE_MAX = 1200;
const PANE_COLLAPSE_THRESHOLD = 80;
const PANE_STORAGE_KEY = 'wickd:run-history-pane-width';

function readPaneWidth(): number {
  try {
    const v = localStorage.getItem(PANE_STORAGE_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= PANE_MIN && n <= PANE_MAX) return n;
    }
  } catch {}
  return PANE_DEFAULT;
}

export interface ResizablePane {
  open: boolean;
  width: number;
  toggle: () => void;
  /** Open at the last width (no-op if already open). */
  reveal: () => void;
  onHandleMouseDown: (e: React.MouseEvent) => void;
}

/** Right-hand detail pane: drag to resize, drag below the threshold to collapse. */
export function useResizablePane(sessionKey: string): ResizablePane {
  const [open, setOpen] = useState(() => {
    try { return sessionStorage.getItem(`${sessionKey}:pane-open`) === 'true'; } catch { return false; }
  });
  const [width, setWidth] = useState(readPaneWidth);
  const lastWidth = useRef(readPaneWidth());
  const resizing = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  function persistOpen(next: boolean) {
    try { sessionStorage.setItem(`${sessionKey}:pane-open`, String(next)); } catch {}
  }

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const delta = startX.current - e.clientX;
      setWidth(Math.max(0, Math.min(PANE_MAX, startW.current + delta)));
    };
    const onMouseUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      setWidth((w) => {
        if (w < PANE_COLLAPSE_THRESHOLD) {
          setOpen(false);
          persistOpen(false);
          return lastWidth.current;
        }
        const clamped = Math.max(PANE_MIN, w);
        lastWidth.current = clamped;
        try { localStorage.setItem(PANE_STORAGE_KEY, String(clamped)); } catch {}
        return clamped;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) setWidth(lastWidth.current);
      persistOpen(next);
      return next;
    });
  }

  function reveal() {
    if (open) return;
    setWidth(lastWidth.current);
    setOpen(true);
    persistOpen(true);
  }

  function onHandleMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    resizing.current = true;
    startX.current = e.clientX;
    if (open) {
      startW.current = width;
    } else {
      startW.current = 0;
      setOpen(true);
      setWidth(0);
    }
    e.preventDefault();
  }

  return { open, width, toggle, reveal, onHandleMouseDown };
}
