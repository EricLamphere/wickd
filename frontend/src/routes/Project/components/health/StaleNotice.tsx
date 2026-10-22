import { AlertTriangle } from 'lucide-react';

interface StaleNoticeProps {
  reasons: string[];
  onRerun?: () => void;
  disabled?: boolean;
}

/** "Results may be out of date" banner shown above a check's results. */
export default function StaleNotice({ reasons, onRerun, disabled }: StaleNoticeProps) {
  if (reasons.length === 0) return null;
  return (
    <div className="flex items-start gap-2 px-5 py-2 border-b border-gray-800 bg-amber-950/20 text-[11px] text-amber-300">
      <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
      <span className="flex-1 min-w-0">
        May be out of date: {reasons.join(' · ')}
      </span>
      {onRerun && (
        <button
          type="button"
          onClick={onRerun}
          disabled={disabled}
          className="shrink-0 font-medium underline underline-offset-2 hover:text-amber-200 disabled:opacity-40"
        >
          Re-run
        </button>
      )}
    </div>
  );
}
