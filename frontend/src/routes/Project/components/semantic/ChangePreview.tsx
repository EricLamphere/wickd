import { ChevronRight, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { DbtChangePlan } from '../../../../lib/semanticApi';
import { describeChange, groupChanges } from './compatDialog';

const GROUPS = [
  { key: 'upgrades', label: 'Upgrades', cls: 'text-gray-300' },
  { key: 'downgrades', label: 'Downgrades', cls: 'text-amber-300' },
  { key: 'installs', label: 'New packages', cls: 'text-gray-300' },
] as const;

/** "What will change": the pip dry-run diff for the chosen dbt-core, or why pip can't resolve it. */
export function ChangePreview({ plan, loading, error }: { plan: DbtChangePlan | undefined; loading: boolean; error: unknown }) {
  const [open, setOpen] = useState(false);
  const grouped = plan ? groupChanges(plan.changes) : null;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-gray-800 bg-surface-elevated/30 px-3 py-2">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-gray-100">
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        What will change
        {loading && <Loader2 className="w-3 h-3 animate-spin text-gray-500" />}
        {loading && <span className="text-[10px] text-gray-500">resolving with pip (needs network)…</span>}
        {!loading && plan?.ok && <span className="text-[10px] text-gray-500">{plan.changes.length} package{plan.changes.length === 1 ? '' : 's'}</span>}
      </button>
      {!loading && plan && !plan.ok && <pre className="text-[11px] font-mono text-red-400 whitespace-pre-wrap">{plan.error}</pre>}
      {!loading && error != null && <span className="text-[11px] text-red-400">{error instanceof Error ? error.message : String(error)}</span>}
      {open && grouped && plan?.ok && (
        <div className="flex flex-col gap-2 pl-4">
          {plan.changes.length === 0 && <span className="text-[11px] text-gray-500">Nothing changes.</span>}
          {GROUPS.map(({ key, label, cls }) => grouped[key].length > 0 && (
            <div key={key} className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-600">{label}</span>
              {grouped[key].map((c) => <span key={c.name} className={`text-[11px] font-mono ${cls}`}>{describeChange(c)}</span>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
