import { useMemo, useState } from 'react';
import type { RunAnalysisDto, RunInvocationDetailDto } from '../../../lib/api';
import { ProFeatureButton } from '../../../components/ProFeatureButton';
import { UpgradeModal } from '../components/UpgradeModal';
import { OPEN_IN_FILES_TITLE } from '../lib/openInFiles';
import {
  buildTimeline,
  formatBytes,
  formatSeconds,
  gapSegments,
  type TimelineBar,
} from '../lib/runTimeline';
import { useProEntitled, useRunAnalysis } from './usePerformance';
import type { FileNav } from './shared';

const LANE_HEIGHT = 22;
const LABEL_WIDTH = 72;

const BAR_COLOR: Record<string, string> = {
  success: 'bg-emerald-600/70 border-emerald-500/60',
  error: 'bg-red-600/70 border-red-500/60',
  warn: 'bg-amber-600/70 border-amber-500/60',
};
const BAR_COLOR_DEFAULT = 'bg-gray-600/70 border-gray-500/60';

function barTitle(bar: TimelineBar, canOpen: boolean): string {
  const lines = [
    bar.name,
    `${formatSeconds(bar.durationS)} (from ${formatSeconds(bar.startS)} to ${formatSeconds(bar.endS)})`,
    `status: ${bar.status}`,
  ];
  if (bar.rowsAffected !== null) lines.push(`rows: ${bar.rowsAffected.toLocaleString()}`);
  if (bar.bytesProcessed !== null) lines.push(`processed: ${formatBytes(bar.bytesProcessed)}`);
  if (canOpen) lines.push(OPEN_IN_FILES_TITLE);
  return lines.join('\n');
}

function shortLane(lane: string): string {
  return lane.replace(/\s*\(worker\)$/, '').replace(/^Thread-/, 'T');
}

interface RunTimelineProps {
  projectId: number;
  detail: RunInvocationDetailDto;
  fileNav: FileNav;
}

/** Gantt chart of one run: a lane per thread, a bar per node (Base). With Pro,
 *  the critical path is highlighted and waits for a free thread are marked. */
export function RunTimeline({ projectId, detail, fileNav }: RunTimelineProps) {
  const layout = useMemo(() => buildTimeline(detail.nodes), [detail.nodes]);
  const { entitled } = useProEntitled();
  const { data: analysis } = useRunAnalysis(projectId, detail.id, entitled && layout !== null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const critical = useMemo(
    () => new Set(analysis?.has_timing ? analysis.critical_path.map((s) => s.unique_id) : []),
    [analysis],
  );
  const gaps = useMemo(
    () => (layout && analysis?.has_timing ? gapSegments(layout, analysis.critical_path) : []),
    [layout, analysis],
  );

  if (!layout) {
    return (
      <div className="flex items-center justify-center h-32 px-6 text-center text-gray-500 text-sm">
        No timing details for this run. wickd records them for runs from now on.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TimelineSummary
        analysis={analysis}
        entitled={entitled}
        wallS={layout.wallS}
        threads={detail.threads}
        onUnlock={() => setUpgradeOpen(true)}
      />
      <div className="flex-1 overflow-auto px-4 py-3">
        {/* Axis */}
        <div className="relative h-4 text-[9px] text-gray-500" style={{ marginLeft: LABEL_WIDTH }}>
          {layout.ticks.map((t) => (
            <span
              key={t.seconds}
              className="absolute -translate-x-1/2 tabular-nums"
              style={{ left: `${t.pct}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
        {layout.lanes.map((lane, laneIdx) => (
          <div key={lane} className="flex items-center" style={{ height: LANE_HEIGHT }}>
            <span
              className="shrink-0 pr-2 text-[10px] font-mono text-gray-500 truncate"
              style={{ width: LABEL_WIDTH }}
              title={lane}
            >
              {shortLane(lane)}
            </span>
            <div className="relative flex-1 h-full border-b border-gray-800/60">
              {layout.ticks.map((t) => (
                <span key={t.seconds} className="absolute top-0 bottom-0 w-px bg-gray-800/60" style={{ left: `${t.pct}%` }} />
              ))}
              {gaps.filter((g) => g.lane === laneIdx).map((g, i) => (
                <span
                  key={`gap-${i}`}
                  title={g.kind === 'starvation'
                    ? `Waited ${formatSeconds(g.seconds)} for a free thread`
                    : `Waited ${formatSeconds(g.seconds)} (compile / scheduling)`}
                  className={`absolute bottom-0 h-[3px] z-20 ${g.kind === 'starvation' ? 'timeline-gap-starvation' : 'timeline-gap-overhead'}`}
                  style={{ left: `${g.leftPct}%`, width: `${g.widthPct}%` }}
                />
              ))}
              {layout.bars.filter((b) => b.lane === laneIdx).map((bar) => {
                const onPath = critical.has(bar.uniqueId);
                const dim = critical.size > 0 && !onPath;
                const canOpen = fileNav.canOpen(bar.uniqueId);
                return (
                  <button
                    key={bar.uniqueId}
                    onClick={(e) => fileNav.handleClick(e, bar.uniqueId)}
                    title={barTitle(bar, canOpen)}
                    className={`absolute top-1 bottom-1 rounded-sm border overflow-hidden px-1 text-left text-[9px] leading-[12px] text-white/90 font-mono truncate transition-opacity
                      ${BAR_COLOR[bar.status] ?? BAR_COLOR_DEFAULT}
                      ${bar.kind === 'test' ? 'opacity-60' : ''}
                      ${dim ? 'opacity-35' : ''}
                      ${onPath ? 'ring-2 ring-amber-400 z-10' : ''}`}
                    style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
                  >
                    {bar.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <TimelineLegend showPro={critical.size > 0} untimed={layout.untimed} />
      </div>
      {upgradeOpen && <UpgradeModal feature="Run performance insights" onClose={() => setUpgradeOpen(false)} />}
    </div>
  );
}

function TimelineSummary({ analysis, entitled, wallS, threads, onUnlock }: {
  analysis: RunAnalysisDto | undefined;
  entitled: boolean;
  wallS: number;
  threads: number | null;
  onUnlock: () => void;
}) {
  const base = `Wall ${formatSeconds(wallS)}${threads ? ` · ${threads} thread${threads === 1 ? '' : 's'}` : ''}`;
  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-gray-800 text-xs text-gray-400">
      {analysis?.has_timing ? (
        <span>
          Wall <span className="text-gray-200">{formatSeconds(analysis.wall_time ?? wallS)}</span>
          {' · '}ideal <span className="text-gray-200">{formatSeconds(analysis.ideal_time ?? 0)}</span>
          {analysis.utilisation !== null && (
            <>{' · '}<span className="text-gray-200">{Math.round(analysis.utilisation * 100)}%</span> thread utilisation</>
          )}
          {analysis.starvation_s > 0 && (
            <>{' · '}<span className="text-amber-300">{formatSeconds(analysis.starvation_s)}</span> waiting for threads</>
          )}
        </span>
      ) : (
        <span>{base}</span>
      )}
      {!entitled && (
        <ProFeatureButton onClick={onUnlock} className="ml-auto" title="Critical path, regressions and recommendations">
          Find the critical path
        </ProFeatureButton>
      )}
    </div>
  );
}

function TimelineLegend({ showPro, untimed }: { showPro: boolean; untimed: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3 mt-3 text-[10px] text-gray-500">
      <span className="flex items-center gap-1"><span className="w-2.5 h-2 rounded-sm bg-emerald-600/70" />success</span>
      <span className="flex items-center gap-1"><span className="w-2.5 h-2 rounded-sm bg-red-600/70" />error</span>
      <span className="flex items-center gap-1"><span className="w-2.5 h-2 rounded-sm bg-emerald-600/70 opacity-60" />test</span>
      {showPro && (
        <>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2 rounded-sm ring-2 ring-amber-400" />critical path</span>
          <span className="flex items-center gap-1"><span className="w-4 h-2 rounded-sm timeline-gap-starvation" />waiting for a thread</span>
        </>
      )}
      {untimed > 0 && <span>{untimed} node{untimed === 1 ? '' : 's'} without timing (skipped)</span>}
      <span className="ml-auto">Cmd+click a bar to open it in Files</span>
    </div>
  );
}
