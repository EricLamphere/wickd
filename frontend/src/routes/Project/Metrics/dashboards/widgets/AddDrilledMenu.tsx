// Drill into…'s "Add to dashboard": pick which of its draft widgets go on the dashboard (as
// configured), with select all / deselect all. Opens above its button in the dialog's footer.
import { useEffect, useRef, useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import type { DashboardWidget } from '../../../../../lib/dashboardsApi';
import { widgetInfo, widgetTitle } from '../dashboardModel';
import type { DrilledChart } from '../drill';

interface Item {
  id: DrilledChart;
  widget: DashboardWidget;
}

interface Props {
  items: Item[];
  labels: Map<string, string>;
  onAdd: (charts: DrilledChart[]) => void;
}

export function AddDrilledMenu({ items, labels, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [unpicked, setUnpicked] = useState<Set<DrilledChart>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);
  const available = items.map((i) => i.id);
  const chosen = available.filter((c) => !unpicked.has(c));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = (id: DrilledChart) => setUnpicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500">
        <LayoutDashboard className="w-3.5 h-3.5" />Add to dashboard
      </button>
      {open && (
        <div role="dialog" aria-label="Add widgets to the dashboard"
          className="absolute right-0 bottom-full z-10 w-80 mb-2 py-2 bg-surface-elevated border border-gray-700 rounded shadow-xl">
          <div className="flex items-center gap-3 px-3 pb-1.5 mb-1 border-b border-gray-800 text-[11px]">
            <span className="flex-1 text-gray-400">Add as widgets</span>
            <button onClick={() => setUnpicked(new Set())} className="text-brand-300 hover:text-brand-200">Select all</button>
            <button onClick={() => setUnpicked(new Set(available))} className="text-brand-300 hover:text-brand-200">Deselect all</button>
          </div>
          {items.map(({ id, widget }) => (
            <label key={id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 cursor-pointer">
              <input type="checkbox" checked={!unpicked.has(id)} onChange={() => toggle(id)} />
              <span className="flex flex-col min-w-0">
                <span className="truncate">{widgetTitle(widget, labels)}</span>
                <span className="text-[10px] text-gray-500">{widgetInfo(widget.type).label}</span>
              </span>
            </label>
          ))}
          <p className="px-3 pt-1 text-[10px] text-gray-500">Added as configured here, filtered to this value.</p>
          <div className="flex justify-end px-3 pt-2">
            <button disabled={!chosen.length} onClick={() => { setOpen(false); onAdd(chosen); }}
              className="px-3 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
              {chosen.length ? `Add ${chosen.length} widget${chosen.length === 1 ? '' : 's'}` : 'Add'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
