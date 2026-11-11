import { useState } from 'react';
import { ChevronRight, RotateCcw, X } from 'lucide-react';
import type { Activity } from '../../lib/activity';
import { formatElapsed, formatStartTime, isRowExpanded, panelRows } from '../../lib/activityView';
import { DbtCommandInput } from '../DbtCommandRow';
import { CopyCommandButton } from './CopyCommandButton';
import { BAR_TONE, STATUS_LABEL, StatusIcon } from './statusStyle';

const LOG_TAIL = 8;

interface ActivityPanelProps {
  projectId: number;
  activities: readonly Activity[];
  now: number;
  /** px; when the bubble was dragged (otherwise the page area bounds it) */
  maxHeight?: number;
  onOpen: (activity: Activity) => void;
  onOpenInRuns: (activity: Activity) => void;
  onCancel: (activity: Activity) => Promise<void>;
  onClose: () => void;
  /** set when the bubble was dragged: puts it back in its corner */
  onResetPosition?: () => void;
}

/**
 * The expanded bubble: current activities first, then recent ones (newest first), five at most.
 * Only the first row starts expanded; the rest show their header until clicked. A `dbt <command>`
 * bar stays pinned at the bottom, outside the scrolling list, to start a run from here.
 */
export function ActivityPanel({
  projectId, activities, now, maxHeight, onOpen, onOpenInRuns, onCancel, onClose, onResetPosition,
}: ActivityPanelProps) {
  const ordered = panelRows(activities);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const toggle = (key: string) => setOverrides((prev) => {
    const next = new Map(prev);
    next.set(key, !isRowExpanded(ordered, key, prev));
    return next;
  });

  return (
    <div
      role="region"
      aria-label="Running activity"
      className="flex flex-col w-96 max-w-[calc(100vw-2rem)] max-h-full min-h-0 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl pointer-events-auto"
      style={maxHeight !== undefined ? { maxHeight: Math.max(maxHeight, 160) } : undefined}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <span className="flex-1 text-xs font-semibold text-gray-200">Activity</span>
        {onResetPosition && (
          <button
            type="button"
            onClick={onResetPosition}
            className="p-1 rounded text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            aria-label="Move the bubble back to the corner"
            title="Move back to the corner"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded text-gray-400 hover:bg-gray-800 hover:text-gray-200"
          aria-label="Close activity panel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-800">
        {ordered.length === 0 && (
          <p className="px-3 py-4 text-xs text-gray-500">No recent activity.</p>
        )}
        {ordered.map((a) => (
          <ActivityRow
            key={a.key}
            activity={a}
            now={now}
            expanded={isRowExpanded(ordered, a.key, overrides)}
            onToggle={() => toggle(a.key)}
            onOpen={onOpen}
            onOpenInRuns={onOpenInRuns}
            onCancel={onCancel}
          />
        ))}
      </div>
      <div className="shrink-0 px-3 py-2.5 border-t border-gray-800">
        <DbtCommandInput projectId={projectId} compact />
      </div>
    </div>
  );
}

interface ActivityRowProps {
  activity: Activity;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (activity: Activity) => void;
  onOpenInRuns: (activity: Activity) => void;
  onCancel: (activity: Activity) => Promise<void>;
}

function elapsedOf(a: Activity, now: number): string | null {
  if (a.startedAt === null) return null;
  return formatElapsed((a.finishedAt ?? now) - a.startedAt);
}

function ActivityRow({ activity: a, now, expanded, onToggle, onOpen, onOpenInRuns, onCancel }: ActivityRowProps) {
  const elapsed = elapsedOf(a, now);
  const startedAt = a.startedAt !== null ? formatStartTime(a.startedAt, now) : null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center min-w-0 pr-2 hover:bg-gray-800/50">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex flex-1 items-center gap-2 min-w-0 pl-3 pr-1 py-2 text-left focus:outline-none focus-visible:bg-gray-800/50"
        >
          <ChevronRight className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <StatusIcon status={a.status} />
          <span className="min-w-0 truncate text-xs font-medium text-gray-100" title={a.commandLine ?? a.title}>{a.title}</span>
          {startedAt && (
            <time
              dateTime={new Date(a.startedAt as number).toISOString()}
              title={new Date(a.startedAt as number).toLocaleString()}
              className="shrink-0 text-[11px] tabular-nums text-gray-500"
            >
              {startedAt}
            </time>
          )}
          <span className="flex-1" />
          {elapsed && <span className="shrink-0 text-[11px] tabular-nums text-gray-400">{elapsed}</span>}
        </button>
        {a.kind === 'run' && a.commandLine && <CopyCommandButton command={a.commandLine} />}
      </div>
      {expanded && <RowDetails activity={a} onOpen={onOpen} onOpenInRuns={onOpenInRuns} onCancel={onCancel} />}
    </div>
  );
}

interface RowDetailsProps {
  activity: Activity;
  onOpen: (activity: Activity) => void;
  onOpenInRuns: (activity: Activity) => void;
  onCancel: (activity: Activity) => Promise<void>;
}

function RowDetails({ activity: a, onOpen, onOpenInRuns, onCancel }: RowDetailsProps) {
  const [cancelling, setCancelling] = useState(false);
  const pct = a.progress && a.progress.total > 0 ? Math.round((a.progress.done / a.progress.total) * 100) : null;
  const tail = a.log.slice(-LOG_TAIL);

  const cancel = async () => {
    setCancelling(true);
    try {
      await onCancel(a);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2.5">
      <div className="flex items-center gap-2 text-[11px] text-gray-500">
        <span>{STATUS_LABEL[a.status]}</span>
        {a.progress && a.progress.total > 0 && <span className="tabular-nums">{a.progress.done}/{a.progress.total}</span>}
        {a.seeded && <span>· started before this page opened</span>}
      </div>
      {pct !== null && (
        <div className="h-1 rounded bg-gray-800 overflow-hidden" aria-hidden>
          <div className={`h-full ${BAR_TONE[a.status]} transition-[width]`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {tail.length > 0 && (
        <pre className="max-h-28 overflow-y-auto px-2 py-1 rounded bg-gray-950 font-mono text-[11px] leading-snug text-gray-400 whitespace-pre-wrap break-all">
          {tail.join('\n')}
        </pre>
      )}
      <div className="flex items-center justify-end gap-2">
        {a.cancellable && a.status === 'running' && (
          <button
            type="button"
            onClick={cancel}
            disabled={cancelling}
            className="px-2 py-0.5 rounded border border-gray-700 text-[11px] text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {a.kind === 'run' ? (
          <>
            <RowButton label="Execution DAG" onClick={() => onOpen(a)} />
            {a.invocationId !== null && <RowButton label="Open in Runs" onClick={() => onOpenInRuns(a)} />}
          </>
        ) : (
          <RowButton label="Open" onClick={() => onOpen(a)} />
        )}
      </div>
    </div>
  );
}

function RowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-0.5 rounded bg-gray-800 text-[11px] text-gray-200 hover:bg-gray-700"
    >
      {label}
    </button>
  );
}
