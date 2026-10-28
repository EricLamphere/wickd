// One monitor on the Monitors tab: status pill, sparkline + expected band, latest value
// vs expected, "since" and the slices with their own status. Draggable to reorder
// (MonitorGrid passes the dnd-kit props).
import type { CSSProperties, HTMLAttributes } from 'react';
import { AlertTriangle, GripVertical, PauseCircle } from 'lucide-react';
import type { MonitorDto } from '../../../../lib/monitorsApi';
import { relativeTime } from '../../lib/relativeTime';
import { MonitorSparkline } from './MonitorSparkline';
import { formatNumber, monitorTitle, statusStyle, vsExpected } from './monitorView';

interface Props {
  monitor: MonitorDto;
  activeTarget: string | null;
  running: boolean;
  onOpen: () => void;
  cardRef?: (el: HTMLButtonElement | null) => void;
  dragProps?: HTMLAttributes<HTMLButtonElement>;
  style?: CSSProperties;
  className?: string;
}

export function MonitorCard({ monitor, activeTarget, running, onOpen, cardRef, dragProps, style: dragStyle, className = '' }: Props) {
  const latest = monitor.latest;
  const style = statusStyle(monitor.enabled ? latest?.status : null, running && monitor.enabled);
  const point = latest?.latest ?? null;
  const comparison = vsExpected(point?.value, point?.expected);
  const target = monitor.target ?? activeTarget;
  const otherTarget = latest && !monitor.target && (latest.target || null) !== (activeTarget || null);

  return (
    <button
      type="button"
      ref={cardRef}
      onClick={onOpen}
      style={dragStyle}
      {...dragProps}
      title={dragProps ? 'Click to open · drag to reorder' : undefined}
      className={`group relative flex flex-col gap-2 min-w-0 px-4 py-3 text-left bg-surface-panel border border-gray-800 rounded-xl hover:border-gray-600 transition-colors ${className}`}
    >
      <span className="flex items-center gap-2 min-w-0">
        {dragProps && (
          <GripVertical className="absolute left-1 top-[1.125rem] w-3.5 h-3.5 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity"
            aria-hidden />
        )}
        <span className="flex-1 text-sm font-medium text-gray-100 truncate" title={monitorTitle(monitor)}>{monitor.metric}</span>
        {!monitor.enabled && <PauseCircle className="w-3.5 h-3.5 text-gray-500" aria-label="Paused" />}
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${style.pill}`}>
          {monitor.enabled ? style.label : 'Paused'}
        </span>
      </span>
      <span className="text-[11px] text-gray-500 truncate">
        {monitor.grain}{monitor.dimension ? ` · by ${monitor.dimension}` : ''} · {monitor.sensitivity} sensitivity
        {target ? ` · ${target}` : ''}{monitor.target ? ' (pinned)' : ''}
      </span>

      <MonitorSparkline points={latest?.recent ?? []} />

      <span className="flex items-baseline gap-2 min-w-0">
        <span className="text-lg font-semibold text-gray-100 tabular-nums">{formatNumber(point?.value)}</span>
        {comparison && <span className="text-[11px] text-gray-400 truncate">{comparison}</span>}
        {point && <span className="ml-auto text-[10px] text-gray-600 shrink-0">{point.period}</span>}
      </span>
      {latest && (
        <span className={`text-xs ${style.text} line-clamp-2`}>
          {latest.headline}{latest.since && latest.status === 'anomaly' ? ` (since ${latest.since})` : ''}
        </span>
      )}
      {latest?.error && <span className="text-[11px] text-red-400 line-clamp-2 break-words">{latest.error}</span>}

      {latest && latest.slices.length > 1 && (
        <span className="flex flex-wrap gap-1">
          {latest.slices.map((s) => {
            const sliceStyle = statusStyle(s.status);
            return (
              <span key={s.slice} title={s.headline} className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${sliceStyle.pill}`}>
                {s.slice}
              </span>
            );
          })}
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[10px] text-gray-600">
        {otherTarget && <AlertTriangle className="w-3 h-3 text-amber-400/90" />}
        {monitor.last_checked_at ? `Checked ${relativeTime(monitor.last_checked_at)}` : 'Not checked yet'}
        {otherTarget ? ` on ${latest?.target || 'the default target'}` : ''}
      </span>
    </button>
  );
}
