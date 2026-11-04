import { useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'wickd:docs-list-width';
const MIN_WIDTH = 160;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 300;

/** The docs tree's width: dragged by its right edge, remembered across pages. */
export function useListWidth() {
  const [listWidth, setListWidth] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10);
      return !isNaN(v) && v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const resizing = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (resizing.current) setListWidth((w) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w + e.movementX)));
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      setListWidth((w) => {
        try { localStorage.setItem(STORAGE_KEY, String(w)); } catch { /* storage unavailable */ }
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
  };

  return { listWidth, startResize };
}
