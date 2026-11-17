// A one-item right-click menu, "Add note…", for places without a menu of their own (monitor
// cards and charts, the metrics sidebar, metric page charts). Rendered on document.body at the
// pointer, kept inside the window.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { StickyNote } from 'lucide-react';
import { addMetricNote } from './noteEvents';
import type { NoteEntry } from './lib/metricNotes';

export interface ExtraItem { label: string; icon?: ReactNode; run: () => void }

export function AddNoteMenu({ x, y, label, entry, extra = [], onClose }: {
  x: number; y: number; label: string; entry: NoteEntry; extra?: ExtraItem[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPos({ left: Math.min(x, window.innerWidth - el.offsetWidth - 8), top: Math.min(y, window.innerHeight - el.offsetHeight - 8) });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onClose, true); };
  }, [onClose]);
  const items: ExtraItem[] = [...extra, { label: 'Add note…', icon: <StickyNote className="w-3.5 h-3.5" />, run: () => addMetricNote(entry) }];
  return createPortal(
    <div ref={ref} role="menu" aria-label={`Actions for ${label}`} style={pos} onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[70] min-w-[11rem] max-w-[18rem] py-1 bg-surface-elevated border border-gray-700 rounded shadow-xl">
      <p className="px-3 pt-1 pb-1.5 text-[10px] text-gray-500 truncate border-b border-gray-800">{label}</p>
      {items.map((item) => (
        <button key={item.label} role="menuitem" onClick={() => { onClose(); item.run(); }}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
          {item.icon}<span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** State + handler for an AddNoteMenu opened by right-click. */
export function useAddNoteMenu() {
  const [at, setAt] = useState<{ x: number; y: number; label: string; entry: NoteEntry; extra?: ExtraItem[] } | null>(null);
  const open = (e: ReactMouseEvent | MouseEvent, label: string, entry: NoteEntry, extra?: ExtraItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setAt({ x: e.clientX, y: e.clientY, label, entry, extra });
  };
  /** at a known point (a chart's right-click callback that already handled the event) */
  const openAt = (x: number, y: number, label: string, entry: NoteEntry, extra?: ExtraItem[]) => setAt({ x, y, label, entry, extra });
  const menu = at ? <AddNoteMenu {...at} onClose={() => setAt(null)} /> : null;
  return { open, openAt, menu };
}
