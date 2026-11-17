import { useRef } from 'react';
import { PackagesPanel } from './PackagesPanel';
import { useFocusPackages } from './useFocusPackages';

/** dbt packages (plan 23); flashed when opened from Health → Packages. */
export function PackagesTab({ projectId }: { projectId: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const highlight = useFocusPackages(ref);
  return (
    <div className="flex-1 p-6">
      <div
        ref={ref}
        className={`bg-surface-panel border rounded-xl transition-[border-color,box-shadow] duration-700
          ${highlight ? 'border-brand-500 ring-2 ring-brand-500/60' : 'border-gray-800 ring-0 ring-transparent'}`}
      >
        <PackagesPanel projectId={projectId} />
      </div>
    </div>
  );
}
