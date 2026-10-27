import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileCode2, Network } from 'lucide-react';
import type { RegressionDto, SlowNodeDto } from '../../../lib/api';
import { RichTable, type RichColumn } from '../../../components/RichTable';
import { RowAction } from '../../../components/RichTableControls';
import { Dumbbell } from '../../../components/charts/Dumbbell';
import { MeterBar } from '../../../components/charts/MeterBar';
import { Sparkline } from '../../../components/charts/Sparkline';
import { NodeName, type NodeFileNav } from '../components/NodeName';
import { useOpenInFiles } from '../lib/openInFiles';
import { changeVsUsual, formatDuration, type ChangeTone } from '../lib/performanceView';
import { NodeRunHistory } from './NodeRunHistory';

const TONE_CHIP: Record<ChangeTone, string> = {
  slower: 'bg-amber-950/40 text-amber-300 border-amber-900/60',
  faster: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60',
  same: 'bg-surface-elevated text-gray-400 border-gray-700',
};

function ChangeChip({ now, usual }: { now: number; usual: number }) {
  const change = changeVsUsual(now, usual);
  if (change.tone === 'same') return null;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] tabular-nums ${TONE_CHIP[change.tone]}`}>
      {change.delta}{change.pct && <span className="opacity-70">{change.pct}</span>}
    </span>
  );
}

function Seconds({ value, muted = false }: { value: number; muted?: boolean }) {
  return <span className={`tabular-nums ${muted ? 'text-gray-400' : 'text-gray-100'}`}>{formatDuration(value)}</span>;
}

function useRowActions(projectId: number, fileNav: ReturnType<typeof useOpenInFiles>) {
  const navigate = useNavigate();
  return (uniqueId: string) => (
    <>
      {fileNav.canOpen(uniqueId) && (
        <RowAction icon={<FileCode2 size={13} />} label="Open in Files" onClick={() => fileNav.open(uniqueId)} />
      )}
      <RowAction
        icon={<Network size={13} />}
        label="Show in DAG"
        onClick={() => navigate(`/projects/${projectId}/models?model=${encodeURIComponent(uniqueId)}`)}
      />
    </>
  );
}

function nodeCell(fileNav: NodeFileNav) {
  return (n: { unique_id: string; name: string; resource_type?: string }) => (
    <NodeName uniqueId={n.unique_id} name={n.name} resourceType={n.resource_type} fileNav={fileNav} />
  );
}

// ── Slowest nodes ────────────────────────────────────────────────────────────

export function SlowestTable({ projectId, nodes, filtered }: { projectId: number; nodes: SlowNodeDto[]; filtered: boolean }) {
  const fileNav = useOpenInFiles(projectId);
  const actions = useRowActions(projectId, fileNav);
  const maxMedian = Math.max(...nodes.map((n) => n.median_s), 0);

  const columns = useMemo<RichColumn<SlowNodeDto>[]>(() => [
    { id: 'node', header: 'Node', cell: nodeCell(fileNav), sortValue: (n) => n.name },
    {
      id: 'median', header: 'Median', align: 'right', width: 'w-48', defaultDir: 'desc', sortValue: (n) => n.median_s,
      headerTitle: 'Median run time across recent successful runs',
      cell: (n) => (
        <span className="inline-flex items-center gap-2.5 justify-end">
          <MeterBar value={n.median_s} max={maxMedian} className="w-24" title="Share of the slowest node’s median" />
          <span className="w-14 text-right"><Seconds value={n.median_s} /></span>
        </span>
      ),
    },
    {
      id: 'last', header: 'Last run', align: 'right', width: 'w-40', defaultDir: 'desc', sortValue: (n) => n.last_s,
      cell: (n) => (
        <span className="inline-flex items-center gap-2 justify-end">
          <ChangeChip now={n.last_s} usual={n.median_s} />
          <span className="w-14 text-right"><Seconds value={n.last_s} muted /></span>
        </span>
      ),
    },
    { id: 'runs', header: 'Runs', align: 'right', width: 'w-16', defaultDir: 'desc', sortValue: (n) => n.runs, cell: (n) => <span className="tabular-nums text-gray-400">{n.runs}</span> },
    {
      id: 'trend', header: 'Recent runs', width: 'w-52', headerTitle: 'Hover for each run’s time; dashed line = median',
      cell: (n) => <Sparkline values={n.recent} format={formatDuration} />,
    },
  ], [fileNav, maxMedian]);

  return (
    <RichTable
      ariaLabel="Slowest nodes"
      rows={nodes}
      columns={columns}
      rowKey={(n) => n.unique_id}
      initialSort={{ id: 'median', dir: 'desc' }}
      rowActions={(n) => actions(n.unique_id)}
      renderExpanded={(n) => (
        <NodeRunHistory
          projectId={projectId}
          uniqueId={n.unique_id}
          name={n.name}
          canOpen={fileNav.canOpen(n.unique_id)}
          onOpenInFiles={() => fileNav.open(n.unique_id)}
          wickyQuestion={`${n.name} usually takes ${formatDuration(n.median_s)}. Why is it slow, and how could I make it faster?`}
        />
      )}
      empty={filtered ? 'No nodes match the filter.' : 'No successful runs to compare yet.'}
    />
  );
}

// ── Regressions ──────────────────────────────────────────────────────────────

export function RegressionsTable({ projectId, regressions }: { projectId: number; regressions: RegressionDto[] }) {
  const fileNav = useOpenInFiles(projectId);
  const actions = useRowActions(projectId, fileNav);
  const scale = Math.max(...regressions.map((r) => Math.max(r.current, r.baseline_median)), 0);

  const columns = useMemo<RichColumn<RegressionDto>[]>(() => [
    { id: 'node', header: 'Node', cell: nodeCell(fileNav), sortValue: (r) => r.name },
    {
      id: 'shift', header: 'Usual → now', width: 'w-44', headerTitle: 'Grey: usual (median of earlier runs). Amber: the latest run. Same scale on every row.',
      cell: (r) => (
        <Dumbbell
          from={r.baseline_median}
          to={r.current}
          max={scale}
          title={`usual ${formatDuration(r.baseline_median)} → now ${formatDuration(r.current)}`}
        />
      ),
    },
    { id: 'usual', header: 'Usual', align: 'right', width: 'w-20', defaultDir: 'desc', sortValue: (r) => r.baseline_median, cell: (r) => <Seconds value={r.baseline_median} muted /> },
    { id: 'now', header: 'Now', align: 'right', width: 'w-20', defaultDir: 'desc', sortValue: (r) => r.current, cell: (r) => <Seconds value={r.current} /> },
    {
      id: 'slower', header: 'Slower by', align: 'right', width: 'w-32', defaultDir: 'desc', sortValue: (r) => r.current - r.baseline_median,
      cell: (r) => <ChangeChip now={r.current} usual={r.baseline_median} />,
    },
    {
      id: 'runs', header: 'Compared', align: 'right', width: 'w-24', defaultDir: 'desc', sortValue: (r) => r.runs_considered,
      headerTitle: 'Earlier runs the usual time is based on',
      cell: (r) => <span className="tabular-nums text-gray-400">{r.runs_considered} runs</span>,
    },
  ], [fileNav, scale]);

  return (
    <RichTable
      ariaLabel="Regressions"
      rows={regressions}
      columns={columns}
      rowKey={(r) => r.unique_id}
      initialSort={{ id: 'slower', dir: 'desc' }}
      empty="No regressions match the filter."
      rowActions={(r) => actions(r.unique_id)}
      renderExpanded={(r) => (
        <NodeRunHistory
          projectId={projectId}
          uniqueId={r.unique_id}
          name={r.name}
          canOpen={fileNav.canOpen(r.unique_id)}
          onOpenInFiles={() => fileNav.open(r.unique_id)}
          wickyQuestion={
            `${r.name} took ${formatDuration(r.current)} in its latest run, usually ${formatDuration(r.baseline_median)}. ` +
            'What could have made it slower, and what should I check?'
          }
        />
      )}
    />
  );
}
