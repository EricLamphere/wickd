import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { usePersistedOpen } from '../../Git/components/PaneSection';

/** Small bordered button used for a Pro check's actions (Check contracts, Diff…). */
export const CHECK_BUTTON = 'flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-300 transition-colors hover:border-brand-600 hover:text-brand-300 disabled:opacity-40';

interface ProCheckSectionProps {
  /** localStorage key for the collapsed state */
  storageKey: string;
  icon: ReactNode;
  title: string;
  /** one line of status next to the title: the latest result, or what's running (shown collapsed too) */
  status?: ReactNode;
  /** buttons on the right of the header */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * A Pro check in the Impact tab (Contracts, Data diff): a bordered, collapsible section whose header
 * keeps the title, the latest result and the actions visible while collapsed.
 */
export function ProCheckSection({ storageKey, icon, title, status, actions, children }: ProCheckSectionProps) {
  const [open, toggle] = usePersistedOpen(storageKey, true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="flex flex-col mx-3 my-2 rounded-lg border border-brand-900/60 bg-brand-950/20 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-h-9 px-3 py-1.5">
        <button onClick={toggle} aria-expanded={open} title={open ? 'Collapse' : 'Expand'}
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-brand-300 hover:text-brand-200">
          <Chevron size={13} className="text-gray-500" />
          {icon}{title}
        </button>
        {status}
        {actions && <div className="flex items-center gap-2 ml-auto">{actions}</div>}
      </div>
      {open && children && <div className="flex flex-col gap-2 px-3 pt-2 pb-2.5 border-t border-brand-900/40">{children}</div>}
    </section>
  );
}

/** Header status of a locked (non-Pro) check. */
export function LockedStatus() {
  return <span className="px-1 rounded bg-brand-900/70 text-[9px] font-semibold uppercase tracking-wider text-brand-300">Pro</span>;
}
