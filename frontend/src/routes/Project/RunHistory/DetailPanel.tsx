import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type RunInvocationDetailDto, type RunInvocationDto } from '../../../lib/api';
import { logLineTone, type LogTone } from '../../../lib/logLineTone';
import { CommandBadge } from '../components/CommandBadge';
import { useOpenInFiles } from '../lib/openInFiles';
import { FailedTestRow } from './FailedTestRow';
import { RunTimeline } from './RunTimeline';
import { TrendRow } from './TrendRow';
import { RerunButton, StatusBadge, formatDuration, formatTime, type FailedRowsCache } from './shared';

const RUN_LOG_TONE_CLASS: Record<LogTone | 'none', string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  success: 'text-emerald-400',
  accent: '',
  none: '',
};

type DetailTab = 'nodes' | 'timeline' | 'log' | 'failed_rows';

interface DetailPanelProps {
  projectId: number;
  invocation: RunInvocationDto;
  onRerun: (invocationId: number) => void;
  failedRowsCache: FailedRowsCache;
  onFailedRowsCached: (uid: string, data: { columns: string[]; rows: unknown[][] }) => void;
}

export function DetailPanel({ projectId, invocation, onRerun, failedRowsCache, onFailedRowsCached }: DetailPanelProps) {
  const fileNav = useOpenInFiles(projectId);
  const [tab, setTab] = useState<DetailTab>('nodes');
  const [nodeFilter, setNodeFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'model' | 'test'>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data, isLoading } = useQuery<RunInvocationDetailDto>({
    queryKey: ['run-invocation', projectId, invocation.id],
    queryFn: () => api.runHistory.detail(projectId, invocation.id),
  });

  const { data: logData, isLoading: logLoading } = useQuery<{ lines: string[] }>({
    queryKey: ['run-invocation-log', projectId, invocation.id],
    queryFn: () => api.runHistory.log(projectId, invocation.id),
    enabled: tab === 'log',
  });

  const filteredNodes = useMemo(() => {
    const nodes = data?.nodes ?? [];
    return nodes.filter((n) => {
      if (kindFilter !== 'all' && n.kind !== kindFilter) return false;
      if (statusFilter !== 'all' && n.status !== statusFilter) return false;
      if (nodeFilter && !n.name.toLowerCase().includes(nodeFilter.toLowerCase())) return false;
      return true;
    });
  }, [data?.nodes, kindFilter, statusFilter, nodeFilter]);

  const allStatuses = useMemo(() => {
    const s = new Set((data?.nodes ?? []).map((n) => n.status));
    return Array.from(s).sort();
  }, [data?.nodes]);

  const modelCount = data?.nodes.filter((n) => n.kind === 'model').length ?? 0;
  const testCount = data?.nodes.filter((n) => n.kind === 'test').length ?? 0;
  const failedTests = useMemo(
    () => (data?.nodes ?? []).filter((n) => n.kind === 'test' && (n.status === 'error' || n.status === 'fail')),
    [data?.nodes],
  );

  const TAB_LABELS: Record<DetailTab, string> = { nodes: 'Nodes', timeline: 'Timeline', log: 'Log', failed_rows: 'Failed Rows' };
  const visibleTabs: DetailTab[] = failedTests.length > 0 ? ['nodes', 'timeline', 'log', 'failed_rows'] : ['nodes', 'timeline', 'log'];

  return (
    <div className="flex flex-col h-full border-l border-gray-800 bg-surface-panel min-w-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-2 min-w-0">
          <CommandBadge command={invocation.command} />
          <span className="text-xs text-gray-400 truncate">{invocation.selector ?? 'all models'}</span>
          <StatusBadge status={invocation.status} />
        </div>
        <RerunButton size="md" onClick={(e) => { e.stopPropagation(); onRerun(invocation.id); }} />
      </div>

      {/* Meta row */}
      <div className="shrink-0 flex gap-5 px-4 py-2 border-b border-gray-800 text-xs text-gray-500">
        <span>Started: <span className="text-gray-300">{formatTime(invocation.started_at)}</span></span>
        <span>Duration: <span className="text-gray-300">{formatDuration(invocation.duration_seconds)}</span></span>
        <span>Models: <span className="text-gray-300">{modelCount}</span></span>
        {testCount > 0 && <span>Tests: <span className="text-gray-300">{testCount}</span></span>}
      </div>

      {/* Tab bar */}
      <div className="shrink-0 flex border-b border-gray-800">
        {visibleTabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
              tab === t
                ? 'border-brand-500 text-brand-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Nodes tab */}
      {tab === 'nodes' && (
        <>
          {/* Filter bar */}
          <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-surface-app">
            <input
              type="text"
              placeholder="Search nodes…"
              value={nodeFilter}
              onChange={(e) => setNodeFilter(e.target.value)}
              className="flex-1 min-w-0 form-input border rounded px-2.5 py-1 text-xs"
            />
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as 'all' | 'model' | 'test')}
              className="form-select border rounded px-2 py-1 text-xs"
            >
              <option value="all">All kinds</option>
              <option value="model">Models</option>
              <option value="test">Tests</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="form-select border rounded px-2 py-1 text-xs"
            >
              <option value="all">All statuses</option>
              {allStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="flex-1 overflow-auto">
            {isLoading ? (
              <div className="flex items-center justify-center h-32 text-gray-500 text-sm">Loading…</div>
            ) : filteredNodes.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-gray-500 text-sm">No nodes match filters.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-800">
                    <th className="px-4 py-2 font-medium">Node</th>
                    <th className="px-4 py-2 font-medium text-right">Time (s)</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNodes.map((n) => (
                    <TrendRow key={n.unique_id} projectId={projectId} node={n} fileNav={fileNav} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {!isLoading && filteredNodes.length > 0 && (
            <p className="shrink-0 px-4 py-1.5 text-[10px] text-gray-500 border-t border-gray-800">
              Click a row to view the trend for that node across its last {20} runs. Cmd+click a name to open it in Files. ⚠ = slower than 10s.
            </p>
          )}
        </>
      )}

      {/* Timeline tab */}
      {tab === 'timeline' && (
        data
          ? <RunTimeline projectId={projectId} detail={data} fileNav={fileNav} />
          : <div className="flex items-center justify-center h-32 text-gray-500 text-sm">{isLoading ? 'Loading…' : 'No data.'}</div>
      )}

      {/* Failed Rows tab */}
      {tab === 'failed_rows' && (
        <div className="flex-1 overflow-auto">
          {failedTests.map((n) => (
            <FailedTestRow
              key={n.unique_id}
              projectId={projectId}
              node={n}
              failedRowsCache={failedRowsCache}
              onFailedRowsCached={onFailedRowsCached}
              fileNav={fileNav}
            />
          ))}
        </div>
      )}

      {/* Log tab */}
      {tab === 'log' && (
        <div className="flex-1 overflow-auto bg-surface-app font-mono text-xs text-gray-300 p-4">
          {invocation.cli_command && (
            <div className="mb-3 pb-3 border-b border-gray-800">
              <span className="text-gray-500">$ </span>
              <span className="text-brand-300">{invocation.cli_command}</span>
            </div>
          )}
          {logLoading ? (
            <span className="text-gray-500">Loading…</span>
          ) : !logData || logData.lines.length === 0 ? (
            <span className="text-gray-500">No log captured for this invocation.</span>
          ) : (
            logData.lines.map((line, i) => (
              <div key={i} className={`whitespace-pre leading-5 ${RUN_LOG_TONE_CLASS[logLineTone(line) ?? 'none']}`}>
                {line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
