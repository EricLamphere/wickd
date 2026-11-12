import { ChevronDown, ChevronUp } from 'lucide-react';

interface PaneTabBarProps<T extends string> {
  tabs: readonly { id: T; label: string }[];
  activeTab: T;
  open: boolean;
  onSelect: (id: T) => void;
  onToggle: () => void;
  /** From usePaneResize: dragging the bar resizes the pane. */
  onBarMouseDown: (e: React.MouseEvent) => void;
}

/** A bottom pane's tab bar: drag handle, tabs, collapse button. */
export function PaneTabBar<T extends string>({ tabs, activeTab, open, onSelect, onToggle, onBarMouseDown }: PaneTabBarProps<T>) {
  return (
    <div
      className="flex items-center gap-1 px-3 border-b border-gray-800 select-none shrink-0 cursor-row-resize"
      style={{ height: 36 }}
      onMouseDown={onBarMouseDown}
    >
      {/* Drag affordance */}
      <div className="w-6 flex flex-col gap-0.5 items-center justify-center shrink-0 mr-1 opacity-40">
        <div className="w-4 h-px bg-gray-500" />
        <div className="w-4 h-px bg-gray-500" />
        <div className="w-4 h-px bg-gray-500" />
      </div>

      {tabs.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onSelect(id)}
          className={`px-3 py-1 text-xs rounded transition-colors whitespace-nowrap
            ${open && activeTab === id ? 'bg-brand-900/50 text-brand-300 font-medium' : 'text-gray-500 hover:text-gray-300'}`}
        >
          {label}
        </button>
      ))}

      <div className="ml-auto">
        <button
          onClick={onToggle}
          className="p-1 rounded text-gray-500 hover:text-gray-300 transition-colors"
          title={open ? 'Collapse pane' : 'Expand pane'}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}
