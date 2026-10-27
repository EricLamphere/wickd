import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FileCode2, Network, Sparkles } from 'lucide-react';
import { api, type NodeTrendPoint } from '../../../lib/api';
import { RunBarsChart } from '../../../components/charts/RunBarsChart';
import { median } from '../../../lib/charts';
import { formatDuration } from '../lib/performanceView';
import { openWicky } from '../lib/wickyEvents';

interface NodeRunHistoryProps {
  projectId: number;
  uniqueId: string;
  name: string;
  canOpen: boolean;
  onOpenInFiles: () => void;
  /** Question for "Ask Wicky", e.g. why it got slower. */
  wickyQuestion?: string;
}

function shortDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Expanded row: every recorded run of one node as bars, a few stats, and where to go next. */
export function NodeRunHistory({ projectId, uniqueId, name, canOpen, onOpenInFiles, wickyQuestion }: NodeRunHistoryProps) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery<NodeTrendPoint[]>({
    queryKey: ['node-trend', projectId, uniqueId],
    queryFn: () => api.runHistory.nodeTrend(projectId, uniqueId),
    staleTime: 30_000,
  });

  const timed = (data ?? []).filter((p) => p.execution_time !== null).map((p) => p.execution_time as number);
  const stats: [string, string][] = timed.length
    ? [
        ['Runs', String(data?.length ?? 0)],
        ['Median', formatDuration(median(timed) ?? 0)],
        ['Fastest', formatDuration(Math.min(...timed))],
        ['Slowest', formatDuration(Math.max(...timed))],
        ['Last', formatDuration(timed[timed.length - 1])],
      ]
    : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {stats.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
            <span className="text-sm font-medium tabular-nums text-gray-100">{value}</span>
          </div>
        ))}
        <span className="flex-1" />
        <div className="flex items-center gap-1.5">
          {canOpen && (
            <ActionButton icon={<FileCode2 size={12} />} label="Open in Files" onClick={onOpenInFiles} />
          )}
          <ActionButton
            icon={<Network size={12} />}
            label="Show in DAG"
            onClick={() => navigate(`/projects/${projectId}/models?model=${encodeURIComponent(uniqueId)}`)}
          />
          {wickyQuestion && (
            <ActionButton icon={<Sparkles size={12} />} label="Ask Wicky" brand onClick={() => openWicky({ question: wickyQuestion, uniqueId, mode: 'explain_slow' })} />
          )}
        </div>
      </div>
      {isLoading ? (
        <div className="h-[150px] rounded-lg bg-surface-elevated/30 animate-pulse" />
      ) : error ? (
        <p className="text-xs text-red-400">Couldn’t load the run history for {name}.</p>
      ) : (data?.length ?? 0) < 2 ? (
        <p className="text-xs text-gray-500">Not enough recorded runs of {name} to chart yet.</p>
      ) : (
        <RunBarsChart
          bars={(data ?? []).map((p) => ({
            id: p.invocation_id,
            value: p.execution_time,
            label: shortDate(p.started_at),
            status: p.status,
          }))}
          format={formatDuration}
        />
      )}
    </div>
  );
}

function ActionButton({ icon, label, onClick, brand = false }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  brand?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors ${
        brand
          ? 'text-brand-300 bg-brand-900/20 hover:bg-brand-900/40'
          : 'border border-gray-700 text-gray-300 hover:bg-surface-elevated'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
