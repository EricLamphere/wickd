// Right-click menu on a value (a bar, a stacked bar segment, a Top N row, a table row, a time
// series' periods): show it over time in the widget (a time series zooms on its periods instead),
// apply it as a dashboard filter (periods become the dashboard's date range), drill into it
// (InspectDialog), open the explorer filtered to it, or add a metric note about it. Rendered on document.body
// at the pointer, kept inside the window.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarRange, Filter, LineChart, Microscope, Search, StickyNote, ZoomIn } from 'lucide-react';
import { isRangeOnly, pickDescription, pickLabel, type Pick } from '../drill';

export interface ValueActions {
  onDrill: (pick: Pick) => void;
  onApplyFilter: (pick: Pick) => void;
  onInspect: (pick: Pick) => void;
  onOpenInExplorer: (pick: Pick) => void;
  /** a metric note prefilled with the value and its period (plan 30) */
  onAddNote?: (pick: Pick) => void;
}

export function ValueMenu({ pick, x, y, actions, onClose }: { pick: Pick; x: number; y: number; actions: ValueActions; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({ left: Math.min(x, window.innerWidth - el.offsetWidth - 8), top: Math.min(y, window.innerHeight - el.offsetHeight - 8) });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onClose, true); };
  }, [onClose]);
  const label = pickLabel(pick);
  const range = isRangeOnly(pick);
  const items = [
    range
      ? { label: `Zoom to ${label}`, icon: <ZoomIn className="w-3.5 h-3.5" />, run: actions.onDrill }
      : { label: 'Show timeseries', icon: <LineChart className="w-3.5 h-3.5" />, run: actions.onDrill },
    { label: range ? 'Apply as dashboard date range' : 'Apply as dashboard filter',
      icon: range ? <CalendarRange className="w-3.5 h-3.5" /> : <Filter className="w-3.5 h-3.5" />, run: actions.onApplyFilter },
    { label: `Drill into ${label}`, icon: <Search className="w-3.5 h-3.5" />, run: actions.onInspect },
    { label: 'Investigate', icon: <Microscope className="w-3.5 h-3.5" />, run: actions.onOpenInExplorer },
    ...(actions.onAddNote ? [{ label: 'Add note…', icon: <StickyNote className="w-3.5 h-3.5" />, run: actions.onAddNote }] : []),
  ];
  return createPortal(
    <div ref={ref} role="menu" aria-label={`Actions for ${label}`} style={pos} onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[70] min-w-[13rem] max-w-[20rem] py-1 bg-surface-elevated border border-gray-700 rounded shadow-xl">
      <p className="px-3 pt-1 pb-1.5 text-[10px] text-gray-500 truncate border-b border-gray-800">
        {pickDescription(pick)}
      </p>
      {items.map((item) => (
        <button key={item.label} role="menuitem" onClick={(e) => { e.stopPropagation(); onClose(); item.run(pick); }}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
          {item.icon}<span className="truncate" title={item.label}>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
