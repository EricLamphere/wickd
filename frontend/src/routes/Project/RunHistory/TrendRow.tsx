import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ModelTimingDto, type NodeTrendPoint } from '../../../lib/api';
import { OPEN_IN_FILES_HOVER_CLS, OPEN_IN_FILES_TITLE } from '../lib/openInFiles';
import { StatusBadge, type FileNav } from './shared';

// ── Sparkline ────────────────────────────────────────────────────────────────

export function Sparkline({ points }: { points: NodeTrendPoint[] }) {
  if (points.length < 2) {
    return <span className="text-gray-500 text-xs">not enough data</span>;
  }
  const times = points.map((p) => p.execution_time ?? 0);
  const max = Math.max(...times, 0.001);
  const W = 120, H = 32, PAD = 2;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const pts = points.map((p, i) => {
    const x = PAD + (i / (points.length - 1)) * innerW;
    const y = PAD + (1 - (p.execution_time ?? 0) / max) * innerH;
    return { x, y, status: p.status };
  });
  const polyline = pts.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <svg width={W} height={H} className="overflow-visible">
      <polyline
        points={polyline}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="text-brand-400"
      />
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={2.5}
          className={p.status === 'error' ? 'fill-red-400' : 'fill-brand-400'}
        />
      ))}
    </svg>
  );
}

// ── TrendRow (single node trend, loaded on demand) ───────────────────────────

export function TrendRow({ projectId, node, fileNav }: { projectId: number; node: ModelTimingDto; fileNav: FileNav }) {
  const [open, setOpen] = useState(false);
  const canOpen = fileNav.canOpen(node.unique_id);
  const { data: trend } = useQuery<NodeTrendPoint[]>({
    queryKey: ['node-trend', projectId, node.unique_id],
    queryFn: () => api.runHistory.nodeTrend(projectId, node.unique_id),
    enabled: open,
    staleTime: 30_000,
  });

  const timeDisplay = node.execution_time === null
    ? '—'
    : node.execution_time >= 10
      ? `⚠ ${node.execution_time.toFixed(2)}`
      : node.execution_time.toFixed(2);

  const kindBadge = node.kind === 'test'
    ? <span className="text-[10px] px-1 py-0.5 rounded cmd-badge-test font-mono">test</span>
    : null;

  return (
    <>
      <tr
        className="border-b border-gray-800/60 hover:bg-surface-elevated cursor-pointer transition-colors"
        onClick={(e) => {
          if (fileNav.handleClick(e, node.unique_id)) return;
          setOpen((o) => !o);
        }}
      >
        <td className="px-4 py-2 font-mono text-gray-300 flex items-center gap-1.5">
          <svg
            className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span
            title={canOpen ? OPEN_IN_FILES_TITLE : undefined}
            className={canOpen ? OPEN_IN_FILES_HOVER_CLS : undefined}
          >
            {node.name}
          </span>
          {kindBadge && <span className="ml-1">{kindBadge}</span>}
        </td>
        <td className={`px-4 py-2 text-right tabular-nums font-mono ${node.execution_time !== null && node.execution_time >= 10 ? 'text-amber-500' : 'text-gray-300'}`}>
          {timeDisplay}
        </td>
        <td className="px-4 py-2"><StatusBadge status={node.status} /></td>
        <td className="px-4 py-2 text-gray-500 max-w-[220px] truncate">{node.message ?? ''}</td>
      </tr>
      {open && (
        <tr className="border-b border-gray-800/40 bg-surface-app/50">
          <td colSpan={4} className="px-6 py-3">
            <div className="flex items-center gap-4">
              <span className="text-xs text-gray-500 shrink-0">Last {trend?.length ?? 0} runs:</span>
              {trend && trend.length > 0 ? (
                <>
                  <Sparkline points={trend} />
                  <div className="flex flex-col text-[10px] text-gray-500 gap-0.5">
                    <span>max: <span className="text-gray-300">{Math.max(...trend.map(p => p.execution_time ?? 0)).toFixed(2)}s</span></span>
                    <span>avg: <span className="text-gray-300">{(trend.reduce((s, p) => s + (p.execution_time ?? 0), 0) / trend.length).toFixed(2)}s</span></span>
                    <span>min: <span className="text-gray-300">{Math.min(...trend.filter(p => p.execution_time !== null).map(p => p.execution_time!)).toFixed(2)}s</span></span>
                  </div>
                </>
              ) : (
                <span className="text-xs text-gray-600">Loading…</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
