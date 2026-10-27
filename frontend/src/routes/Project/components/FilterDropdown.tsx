import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/** Multi-select checkbox dropdown used by the DAG filter bars (main DAG + bottom-pane Node DAG) and Run History. */
interface FilterDropdownProps {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  closeSignal?: number;
  /** One value at most (radio buttons; picking closes the menu, picking it again clears it). */
  single?: boolean;
  /** Label for an option (defaults to the option itself). */
  optionLabel?: (option: string) => string;
}

export function FilterDropdown({
  label, options, selected, onChange, closeSignal = 0, single = false, optionLabel = (o) => o,
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (closeSignal > 0) setOpen(false);
  }, [closeSignal]);

  if (options.length === 0) return null;

  const count = selected.size;

  const toggle = (opt: string) => {
    if (single) {
      onChange(selected.has(opt) ? new Set() : new Set([opt]));
      setOpen(false);
      return;
    }
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange(next);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border transition-colors ${
          count > 0
            ? 'bg-brand-600/20 border-brand-500 text-brand-300'
            : 'bg-surface-elevated border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300'
        }`}
      >
        {single && count > 0 ? `${label}: ${optionLabel([...selected][0])}` : label}
        {!single && count > 0 && (
          <span className="ml-0.5 bg-brand-500 text-white rounded-full px-1 text-[10px] leading-none py-0.5">
            {count}
          </span>
        )}
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[140px] max-h-60 overflow-y-auto bg-gray-900 border border-gray-700 rounded shadow-xl py-1">
          {options.map((opt) => (
            <label
              key={opt}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800 cursor-pointer"
            >
              <input
                type={single ? 'radio' : 'checkbox'}
                checked={selected.has(opt)}
                onChange={() => toggle(opt)}
                className="accent-brand-500"
              />
              {optionLabel(opt)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
