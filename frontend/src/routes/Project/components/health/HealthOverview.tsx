import { AlertTriangle, ChevronRight } from 'lucide-react';
import type { CheckSummary } from '../../../../lib/api';
import { relativeTime } from '../../lib/relativeTime';
import { TONE_DOT, TONE_TEXT, toneFor } from './healthStatus';
import RunButton from './RunButton';
import Spinner from './Spinner';
import MonitorsCard from './MonitorsCard';
import TestGapsCard from './TestGapsCard';
import { type HealthCheckKind, errorMessage, useHealthRuns, useHealthSummary, useIsStarting } from './useHealth';

interface CardSpec {
  kind: HealthCheckKind;
  title: string;
  description: string;
}

const CARDS: CardSpec[] = [
  { kind: 'connection', title: 'Connection', description: 'dbt debug: profile, credentials, warehouse connection and packages' },
  { kind: 'drift', title: 'Schema Drift', description: 'Columns in your YAML vs. the columns actually in the warehouse' },
  { kind: 'freshness', title: 'Source Freshness', description: 'How recently each source was loaded, against its freshness thresholds' },
  { kind: 'semantic', title: 'Semantic Layer', description: 'MetricFlow validations of your semantic models, metrics and saved queries' },
];

interface HealthOverviewProps {
  projectId: number;
  onOpen: (kind: HealthCheckKind) => void;
  onOpenTestGaps: () => void;
}

export default function HealthOverview({ projectId, onOpen, onOpenTestGaps }: HealthOverviewProps) {
  const { data: summary, isLoading, error } = useHealthSummary(projectId);
  const runs = useHealthRuns(projectId);
  const starting = {
    connection: useIsStarting('connection', projectId),
    drift: useIsStarting('drift', projectId),
    freshness: useIsStarting('freshness', projectId),
    semantic: useIsStarting('semantic', projectId),
  };
  // the Semantic Layer card only shows for projects with semantic models or metrics
  const cards = CARDS.filter(({ kind }) => kind !== 'semantic' || summary?.semantic);
  const semanticRunnable = !!summary?.semantic && summary.semantic.runnable !== false;
  const anyRunning = cards.some(({ kind }) => starting[kind] || summary?.[kind]?.status === 'running');

  return (
    <div className="p-6 pb-12 max-w-[62rem] mx-auto w-full flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-gray-500">
          {summary?.current_target
            ? <>Checks run against target <span className="font-mono text-gray-300">{summary.current_target}</span></>
            : 'Checks run against the profile’s default target'}
        </p>
        <RunButton running={anyRunning} onClick={() => runs.runAll(semanticRunnable)} label="Run all" />
      </div>

      {error && <p className="text-xs text-red-400">Couldn't load health status: {errorMessage(error)}</p>}
      {isLoading && <p className="text-xs text-gray-600">Loading…</p>}

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {cards.map((card) => (
            <HealthCard
              key={card.kind}
              spec={card}
              check={summary[card.kind]!}
              starting={starting[card.kind]}
              startError={runs[card.kind].error}
              onRun={() => runs[card.kind].mutate(undefined)}
              onOpen={() => onOpen(card.kind)}
            />
          ))}
          {summary.monitors && <MonitorsCard projectId={projectId} check={summary.monitors} />}
          <TestGapsCard projectId={projectId} onOpen={onOpenTestGaps} />
        </div>
      )}
    </div>
  );
}

interface HealthCardProps {
  spec: CardSpec;
  check: CheckSummary;
  starting: boolean;
  startError: Error | null;
  onRun: () => void;
  onOpen: () => void;
}

function HealthCard({ spec, check, starting, startError, onRun, onOpen }: HealthCardProps) {
  const running = starting || check.status === 'running';
  const tone = running ? 'running' : toneFor(check.status);

  return (
    <div className="flex flex-col bg-surface-panel border border-gray-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="group flex-1 flex flex-col gap-2 px-4 pt-4 pb-3 text-left hover:bg-surface-elevated/30 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${TONE_DOT[tone]}`} />
          <span className="flex-1 text-sm font-semibold text-gray-100">{spec.title}</span>
          <ChevronRight className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-300 transition-colors" />
        </span>
        <span className={`flex items-center gap-1.5 text-xs ${TONE_TEXT[tone]}`}>
          {running && <Spinner className="w-3 h-3" />}
          {running && check.status !== 'running' ? 'Starting…' : check.headline}
        </span>
        <span className="text-[11px] text-gray-600 leading-relaxed">{spec.description}</span>
        {check.stale_reasons.length > 0 && !running && (
          <span className="flex items-start gap-1.5 text-[11px] text-amber-400/90">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            {check.stale_reasons.join(' · ')}
          </span>
        )}
        {startError && <span className="text-[11px] text-red-400 break-words">{errorMessage(startError)}</span>}
      </button>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-gray-800">
        <span className="text-[10px] text-gray-600 truncate">
          {check.finished_at ? `Last run ${relativeTime(check.finished_at)}` : 'Never run'}
          {check.target ? ` · ${check.target}` : ''}
        </span>
        <RunButton running={running} onClick={onRun} />
      </div>
    </div>
  );
}
