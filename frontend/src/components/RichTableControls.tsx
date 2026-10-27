import type { ReactNode } from 'react';
import { Search, X } from 'lucide-react';

/** Search box for filtering a RichTable. */
export function TableSearch({ value, onChange, placeholder = 'Filter…' }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="relative flex items-center w-56">
      <Search size={12} className="absolute left-2.5 text-gray-500 pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onChange(''); }}
        placeholder={placeholder}
        className="w-full pl-7 pr-7 py-1.5 text-xs rounded-md border border-gray-700 bg-surface-app text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-brand-600"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear filter" className="absolute right-2 text-gray-500 hover:text-gray-300">
          <X size={12} />
        </button>
      )}
    </label>
  );
}

/** Small icon button for a RichTable row's hover actions. */
export function RowAction({ icon, label, onClick, tone = 'default' }: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'brand';
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`p-1.5 rounded-md transition-colors ${
        tone === 'brand'
          ? 'text-brand-300 hover:bg-brand-900/40'
          : 'text-gray-400 hover:text-gray-100 hover:bg-surface-elevated'
      }`}
    >
      {icon}
    </button>
  );
}
