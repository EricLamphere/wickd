// A widget's ⋯ menu: the dashboards' widget frames, the metric page's charts and the
// Investigate window's widget. Their data items are the same everywhere (useChartExports). Closes on a click outside, Escape or picking an item.
// An item with a `submenu` (e.g. Open metric page on a widget with several metrics) expands its choices in place.
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';

export interface WidgetMenuItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** a line above it: the start of a group */
  divider?: boolean;
  /** choices shown under it when clicked (onClick isn't called) */
  submenu?: { label: string; onClick: () => void }[];
}

export function Menu({ items, onClose }: { items: WidgetMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="absolute right-0 top-6 z-30 min-w-[11rem] py-1 bg-surface-elevated border border-gray-700 rounded shadow-xl">
      {items.map((item, i) => (
        <Fragment key={item.label}>
          {item.divider && i > 0 && <div role="separator" className="my-1 border-t border-gray-700/70" />}
          <button role="menuitem" disabled={item.disabled} aria-haspopup={item.submenu ? 'true' : undefined}
            aria-expanded={item.submenu ? expanded === item.label : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (item.submenu) { setExpanded((x) => (x === item.label ? null : item.label)); return; }
              onClose();
              item.onClick();
            }}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-gray-800 disabled:opacity-40 ${item.danger ? 'text-red-300' : 'text-gray-300'}`}>
            {item.icon}{item.label}
            {item.submenu && (expanded === item.label
              ? <ChevronDown className="w-3 h-3 ml-auto text-gray-500" /> : <ChevronRight className="w-3 h-3 ml-auto text-gray-500" />)}
          </button>
          {item.submenu && expanded === item.label && item.submenu.map((sub) => (
            <button key={sub.label} role="menuitem" onClick={(e) => { e.stopPropagation(); onClose(); sub.onClick(); }}
              className="flex items-center w-full pl-9 pr-3 py-1 text-left text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200">
              <span className="truncate">{sub.label}</span>
            </button>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/** The ⋯ button with its menu. */
export function WidgetMenuButton({ items, className = '' }: { items: WidgetMenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`relative shrink-0 ${className}`} data-export-hide="">
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} aria-label="Widget menu" aria-haspopup="menu" aria-expanded={open}
        className="p-0.5 rounded text-gray-500 hover:bg-gray-800 hover:text-gray-200">
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && <Menu items={items} onClose={() => setOpen(false)} />}
    </div>
  );
}
