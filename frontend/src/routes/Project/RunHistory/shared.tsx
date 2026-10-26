import { RotateCw } from 'lucide-react';
import type { useOpenInFiles } from '../lib/openInFiles';

export type FileNav = ReturnType<typeof useOpenInFiles>;

export type FailedRowsCache = Map<string, { columns: string[]; rows: unknown[][] }>;

function statusCls(status: string) {
  if (status === 'success') return 'status-badge-success';
  if (status === 'error') return 'status-badge-error';
  if (status === 'running') return 'status-badge-running';
  if (status === 'cancelled') return 'bg-amber-900/40 text-amber-400';
  return 'bg-surface-elevated text-gray-400';
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusCls(status)}`}>
      {status}
    </span>
  );
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(0).padStart(2, '0');
  return `${m}m ${s}s`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  // Treat bare ISO strings (no Z or UTC offset) as UTC — SQLite returns naive datetimes
  const normalized = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  return new Date(normalized).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function StopButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title="Stop run"
      className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
    >
      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
        <rect x="4" y="4" width="16" height="16" rx="2" />
      </svg>
    </button>
  );
}

export function RerunButton({ onClick, size = 'sm' }: { onClick: (e: React.MouseEvent) => void; size?: 'sm' | 'md' }) {
  const cls = size === 'md'
    ? 'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-surface-elevated hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors'
    : 'p-1 rounded text-gray-500 hover:text-brand-400 hover:bg-brand-900/20 transition-colors';
  return (
    <button onClick={onClick} title="Rerun" className={cls}>
      <RotateCw className="w-3.5 h-3.5" />
      {size === 'md' && 'Rerun'}
    </button>
  );
}
