import { Activity as ActivityIcon, AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { ActivityStatus } from '../../lib/activity';
import type { BubbleStatus } from '../../lib/activityView';

/** Bubble fill + ring per status: blue running, green success, red error, amber warn, gray idle. */
export const BUBBLE_TONE: Record<BubbleStatus, string> = {
  idle: 'bg-gray-900/90 border-gray-600/70 text-gray-300',
  running: 'bg-blue-950/90 border-blue-500/70 text-blue-100',
  success: 'bg-green-950/90 border-green-500/70 text-green-100',
  error: 'bg-red-950/90 border-red-500/70 text-red-100',
  warn: 'bg-amber-950/90 border-amber-500/70 text-amber-100',
};

export const BAR_TONE: Record<ActivityStatus, string> = {
  running: 'bg-blue-500',
  success: 'bg-green-500',
  error: 'bg-red-500',
  warn: 'bg-amber-500',
};

export const STATUS_LABEL: Record<BubbleStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  success: 'Succeeded',
  error: 'Failed',
  warn: 'Finished with warnings',
};

export function StatusIcon({ status, className = 'w-4 h-4' }: { status: BubbleStatus; className?: string }) {
  switch (status) {
    case 'idle': return <ActivityIcon className={`${className} text-gray-400`} aria-label="Idle" />;
    case 'running': return <Loader2 className={`${className} text-blue-400 motion-safe:animate-spin`} aria-label="Running" />;
    case 'success': return <CheckCircle2 className={`${className} text-green-400`} aria-label="Succeeded" />;
    case 'error': return <XCircle className={`${className} text-red-400`} aria-label="Failed" />;
    case 'warn': return <AlertTriangle className={`${className} text-amber-400`} aria-label="Warnings" />;
  }
}
