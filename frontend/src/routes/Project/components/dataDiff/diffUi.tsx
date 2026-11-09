// Data diff (Pro) pills shared by the Impact tab, the Git page and the side pane.
import type { DiffBadge, DiffSummary } from '../../lib/dataDiff';

export const DIFF_TONE: Record<DiffBadge['tone'], string> = {
  ok: 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300',
  warn: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
  error: 'border-red-900/60 bg-red-950/40 text-red-300',
  running: 'border-brand-900/60 bg-brand-950/40 text-brand-300 animate-pulse',
  muted: 'border-gray-700 bg-gray-800/60 text-gray-400',
};

/** One model's latest diff as a pill; clickable when `onClick` is set. */
export function DiffBadgePill({ badge, onClick, className = '' }: { badge: DiffBadge; onClick?: () => void; className?: string }) {
  const stale = badge.stale ? 'border-dashed opacity-60' : '';
  const cls = `max-w-full truncate px-1.5 py-0.5 rounded border text-[10px] font-mono ${DIFF_TONE[badge.tone]} ${stale} ${className}`;
  const text = badge.stale ? `${badge.text} · stale` : badge.text;
  if (!onClick) return <span title={badge.title} className={cls}>{text}</span>;
  return (
    <button onClick={onClick} title={`${badge.title}\nClick for details`} className={`${cls} hover:brightness-125`}>
      {text}
    </button>
  );
}

/** Each diffed model's name and result, what needs attention first. */
export function DiffResultChips({ summary, onOpen, limit }: {
  summary: DiffSummary;
  onOpen: (uniqueId: string) => void;
  /** show at most this many, then "+N more" */
  limit?: number;
}) {
  const shown = limit ? summary.items.slice(0, limit) : summary.items;
  const hidden = summary.items.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((item) => (
        <button key={item.uid} onClick={() => onOpen(item.uid)} title={`${item.badge.title}\nClick for details`}
          className="flex items-center gap-1.5 max-w-full min-w-0 pl-2 pr-1 py-0.5 rounded border border-gray-800 bg-surface-panel text-[11px] transition-colors hover:border-gray-600">
          <span className="font-mono text-gray-300 truncate">{item.name}</span>
          <DiffBadgePill badge={item.badge} className="shrink-0" />
        </button>
      ))}
      {hidden > 0 && <span className="text-[11px] text-gray-500">+{hidden} more</span>}
    </div>
  );
}
