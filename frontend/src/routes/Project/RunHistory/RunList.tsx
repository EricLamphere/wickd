import type { RunInvocationDto } from '../../../lib/api';
import { CommandBadge } from '../components/CommandBadge';
import { RerunButton, StatusBadge, StopButton, formatDuration, formatTime } from './shared';

interface RunListProps {
  invocations: RunInvocationDto[];
  total: number;
  isLoading: boolean;
  selectedId: number | null;
  onRowClick: (inv: RunInvocationDto) => void;
  onStop: () => void;
  onRerun: (invocationId: number) => void;
}

export function RunList({ invocations, total, isLoading, selectedId, onRowClick, onStop, onRerun }: RunListProps) {
  return (
    <div className="flex-1 overflow-auto">
      {isLoading ? (
        <div className="flex items-center justify-center h-32 text-gray-500 text-sm">Loading…</div>
      ) : invocations.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 gap-2 text-gray-500">
          <svg className="w-8 h-8 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm">{total === 0 ? 'No runs recorded yet.' : 'No runs match filters.'}</p>
        </div>
      ) : (
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-panel z-10">
            <tr className="border-b border-gray-800 text-left text-[10px] uppercase tracking-wider text-gray-500">
              <th className="px-4 py-2 font-medium">Started</th>
              <th className="px-4 py-2 font-medium">Profile</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Cmd</th>
              <th className="px-4 py-2 font-medium">Selector</th>
              <th className="px-4 py-2 font-medium text-right">Duration</th>
              <th className="px-4 py-2 font-medium text-right">Results</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium w-8" />
            </tr>
          </thead>
          <tbody>
            {invocations.map((inv) => {
              const isActive = inv.id === selectedId;
              return (
                <tr
                  key={inv.id}
                  onClick={() => onRowClick(inv)}
                  className={`border-b border-gray-800/60 cursor-pointer transition-colors ${isActive ? 'bg-brand-900/20' : 'hover:bg-surface-elevated'}`}
                >
                  <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap font-mono">{formatTime(inv.started_at)}</td>
                  <td className="px-4 py-2.5 text-gray-400 max-w-[120px] truncate">
                    {inv.profile ?? <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-gray-400 font-mono">
                    {inv.target ?? <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5"><CommandBadge command={inv.command} /></td>
                  <td className="px-4 py-2.5 text-gray-400 max-w-[140px] truncate font-mono">
                    {inv.selector ?? <span className="text-gray-600 italic">all</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">{formatDuration(inv.duration_seconds)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">
                    {inv.status === 'running' ? (
                      <span className="text-gray-500">—</span>
                    ) : inv.model_count === 0 ? (
                      <span className="text-gray-500">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <span className="result-ok">{inv.success_count} ok</span>
                        {inv.error_count > 0 && <span className="result-err">{inv.error_count} err</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={inv.status} /></td>
                  <td className="px-2 py-2">
                    {inv.status === 'running' ? (
                      <StopButton onClick={onStop} />
                    ) : (
                      <RerunButton onClick={(e) => { e.stopPropagation(); onRerun(inv.id); }} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
