import { useState } from 'react';
import { Gauge, Sparkles } from 'lucide-react';
import { isProFeatureRequiredError, type RecommendationDto } from '../../../lib/api';
import { ProFeatureButton } from '../../../components/ProFeatureButton';
import { UpgradeModal } from '../components/UpgradeModal';
import { useOpenInFiles } from '../lib/openInFiles';
import { openWicky } from '../lib/wickyEvents';
import { incrementalDraftQuestion, matchesQuery, savingLabel, typeCounts } from '../lib/performanceView';
import { FilterDropdown } from '../components/FilterDropdown';
import { TableSearch } from '../../../components/RichTableControls';
import { RegressionsTable, SlowestTable } from './PerformanceTables';
import { useProEntitled, useProjectPerformance } from './usePerformance';

const FEATURE = 'Run performance insights';
const COMMANDS = ['build', 'run', 'test', 'seed'];


/** Pro: recommendations, regressions and slowest nodes across recent runs. */
export function PerformanceTab({ projectId }: { projectId: number }) {
  const { entitled, loading: licenseLoading } = useProEntitled();
  const [command, setCommand] = useState('');
  const [query, setQuery] = useState('');
  const [types, setTypes] = useState<Set<string>>(new Set());
  const { data, isLoading, error } = useProjectPerformance(projectId, command, entitled);
  const matchesNode = (name: string, type: string) => matchesQuery(name, query) && (types.size === 0 || types.has(type));
  // search + Type filter the Slowest nodes table; Command scopes the whole tab
  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <TableSearch value={query} onChange={setQuery} placeholder="Filter nodes…" />
      <FilterDropdown
        label="Type"
        options={typeCounts(data?.slowest ?? []).map(([t]) => t)}
        selected={types}
        onChange={setTypes}
      />
      <FilterDropdown
        label="Command"
        options={COMMANDS}
        selected={command ? new Set([command]) : new Set()}
        onChange={(next) => setCommand([...next][0] ?? '')}
        single
      />
    </div>
  );
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const locked = (!licenseLoading && !entitled) || isProFeatureRequiredError(error);
  if (locked) {
    return (
      <>
        <LockedState onUnlock={() => setUpgradeOpen(true)} />
        {upgradeOpen && <UpgradeModal feature={FEATURE} onClose={() => setUpgradeOpen(false)} />}
      </>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
      {data && (
        <p className="text-xs text-gray-500">
          Based on the last {data.runs_considered} run{data.runs_considered === 1 ? '' : 's'}
          {command ? ` of dbt ${command}` : ''} ({data.runs_with_timing} with timing details)
        </p>
      )}

      {isLoading || licenseLoading ? (
        <p className="text-sm text-gray-500">Analyzing runs…</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error instanceof Error ? error.message : String(error)}</p>
      ) : !data || data.runs_considered === 0 ? (
        <div className="space-y-3">
          {command && filters}
          <p className="text-sm text-gray-500">
            {command ? `No finished dbt ${command} runs yet.` : 'No finished runs yet. Run or build some models, then come back.'}
          </p>
        </div>
      ) : (
        <>
          <Section title="Recommendations" count={data.recommendations.length}>
            {data.recommendations.length === 0 ? (
              <p className="text-xs text-gray-500">
                {data.runs_with_timing === 0
                  ? 'Recommendations need timing details, which wickd records for runs from now on.'
                  : 'Nothing stands out. Runs look healthy.'}
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {data.recommendations.map((rec) => (
                  <RecommendationCard key={`${rec.kind}:${rec.unique_id ?? ''}`} projectId={projectId} rec={rec} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Regressions" count={data.regressions.length}>
            {data.regressions.length === 0 ? (
              <p className="text-xs text-gray-500">
                No node is meaningfully slower than usual (at least 50% and 5s slower than its median, with 3+ earlier runs).
              </p>
            ) : (
              <RegressionsTable projectId={projectId} regressions={data.regressions} />
            )}
          </Section>

          <Section title="Slowest nodes" count={data.slowest.length}>
            <div className="mb-2.5">{filters}</div>
            {data.slowest.length === 0
              ? <p className="text-xs text-gray-500">No successful runs to compare yet.</p>
              : <SlowestTable projectId={projectId} nodes={data.slowest.filter((n) => matchesNode(n.name, n.resource_type))} filtered={!!query || types.size > 0} />}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        {title}
        <span className="px-1.5 rounded bg-surface-elevated text-[10px] font-normal text-gray-500">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function RecommendationCard({ projectId, rec }: { projectId: number; rec: RecommendationDto }) {
  const fileNav = useOpenInFiles(projectId);
  const saving = savingLabel(rec);
  const canOpen = rec.unique_id !== null && fileNav.canOpen(rec.unique_id);
  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-800 bg-surface-panel">
      <div className="flex items-start gap-2">
        <Gauge size={14} className="mt-0.5 shrink-0 text-brand-400" />
        <span className="flex-1 text-sm font-medium text-gray-100">{rec.title}</span>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${rec.confidence === 'high' ? 'bg-emerald-950/40 text-emerald-300' : 'bg-surface-elevated text-gray-400'}`}>
          {rec.confidence}
        </span>
      </div>
      <ul className="pl-6 space-y-0.5 list-disc text-xs text-gray-400">
        {rec.evidence.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <div className="flex items-center gap-2 pl-6 text-xs">
        {saving && <span className="text-amber-300">{saving}</span>}
        <span className="flex-1" />
        {canOpen && (
          <button
            onClick={() => fileNav.open(rec.unique_id!)}
            className="px-2 py-1 rounded form-btn border text-xs transition-colors"
          >
            Open model
          </button>
        )}
        {rec.kind === 'make_incremental' && (
          <button
            onClick={() => openWicky({ question: incrementalDraftQuestion(rec), uniqueId: rec.unique_id ?? undefined })}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-brand-300 bg-brand-900/20 hover:bg-brand-900/40 transition-colors"
          >
            <Sparkles size={11} />
            Ask Wicky to draft it
          </button>
        )}
      </div>
    </div>
  );
}

function LockedState({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <Gauge size={28} className="text-gray-600" />
      <h2 className="text-sm font-semibold text-gray-200">Find out why runs are slow</h2>
      <p className="max-w-md text-xs text-gray-500">
        wickd Pro finds each run's critical path, flags models that got slower than their usual time,
        and recommends concrete changes: making a model incremental, materializing a busy view, or raising threads.
      </p>
      <ProFeatureButton onClick={onUnlock}>Unlock performance insights</ProFeatureButton>
    </div>
  );
}
