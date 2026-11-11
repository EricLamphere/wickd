// Top-level in-page tab row (Health, Runs, Metrics): underlined tabs sitting on the
// header's bottom border. Pair with useUrlTab() for the active tab so it's sticky
// and part of back/forward history.
import type { ReactNode } from 'react';

export interface PageTabItem<T extends string> {
  id: T;
  /** Tab text plus any trailing badge / dot. */
  label: ReactNode;
}

interface PageTabsProps<T extends string> {
  tabs: readonly PageTabItem<T>[];
  active: T;
  onChange: (id: T) => void;
}

export function PageTabs<T extends string>({ tabs, active, onChange }: PageTabsProps<T>) {
  return (
    <div className="flex gap-1" role="tablist">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm rounded-t whitespace-nowrap transition-colors border-b-2 -mb-px ${
              selected
                ? 'text-brand-300 border-brand-500 font-medium'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
