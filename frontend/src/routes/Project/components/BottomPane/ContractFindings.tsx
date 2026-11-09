import type { MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileCode2, Lightbulb } from 'lucide-react';
import type { BreakingChange, ContractFinding, ContractResult, ContractSeverity } from '../../../../lib/contractsApi';
import { OPEN_IN_FILES_HOVER_CLS, OPEN_IN_FILES_TITLE } from '../../lib/openInFiles';
import { consumerGroups, findingDetail, findingLabel, type ConsumerChip } from '../../lib/contractChecks';
import { metricPageUrl } from '../../Metrics/lib/exploreLink';
import { resourcePill } from '../../lib/resourceTypeStyle';

type NodeClick = (e: MouseEvent, uniqueId: string) => void;

const SEVERITY_PILL: Record<ContractSeverity, string> = {
  error: 'bg-red-950/40 border-red-900/60 text-red-300',
  warning: 'bg-amber-950/40 border-amber-900/60 text-amber-300',
  info: 'bg-gray-800/60 border-gray-700 text-gray-400',
  none: 'bg-emerald-950/30 border-emerald-900/50 text-emerald-300',
};
const SEVERITY_BAR: Record<ContractSeverity, string> = {
  error: 'border-l-red-500/70', warning: 'border-l-amber-400/70', info: 'border-l-gray-600', none: 'border-l-emerald-500/60',
};
const CHANGE_PILL: Record<BreakingChange['change'], string> = {
  removed: 'bg-red-950/40 border-red-900/60 text-red-300',
  renamed: 'bg-amber-950/40 border-amber-900/60 text-amber-300',
  retyped: 'bg-sky-950/40 border-sky-900/60 text-sky-300',
};
const FINDING_PILL: Record<ContractFinding['kind'], string> = {
  missing: 'bg-red-950/40 border-red-900/60 text-red-300',
  extra: 'bg-red-950/40 border-red-900/60 text-red-300',
  type_mismatch: 'bg-sky-950/40 border-sky-900/60 text-sky-300',
  unknown_columns: 'bg-amber-950/40 border-amber-900/60 text-amber-300',
};
const CHIP_TONE: Record<ConsumerChip['kind'], string> = {
  node: 'border-gray-700 text-gray-300',
  metric: resourcePill('metric'),
  saved_query: resourcePill('saved_query'),
  dashboard: 'border-brand-800 bg-brand-900/30 text-brand-300',
  monitor: 'border-sky-900/60 bg-sky-950/30 text-sky-300',
};
const PILL = 'inline-flex items-center px-1.5 rounded border text-[10px] font-medium shrink-0';
const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono break-all text-left';
const SEVERITY_RANK: Record<ContractSeverity, number> = { error: 0, warning: 1, info: 2, none: 3 };

function Chip({ projectId, chip, onNodeClick }: { projectId: number; chip: ConsumerChip; onNodeClick: NodeClick }) {
  const navigate = useNavigate();
  const metrics = `/projects/${projectId}/metrics`;
  if (chip.kind === 'node') {
    return (
      <button onClick={(e) => onNodeClick(e, chip.uniqueId)}
        title={[chip.title, OPEN_IN_FILES_TITLE].filter(Boolean).join(' · ')}
        className={`${CHIP} ${CHIP_TONE.node} ${chip.uncertain ? 'border-dashed' : ''} cursor-default mod:cursor-pointer ${OPEN_IN_FILES_HOVER_CLS}`}>
        {chip.label}
      </button>
    );
  }
  if (chip.kind === 'saved_query') return <span className={`${CHIP} ${CHIP_TONE.saved_query}`}>{chip.label}</span>;
  const to = chip.kind === 'metric' ? metricPageUrl(projectId, chip.metric)
    : chip.kind === 'dashboard' ? `${metrics}?tab=dashboards&dashboard=${encodeURIComponent(chip.slug)}`
      : `${metrics}?tab=monitors&monitor=${chip.monitorId}`;
  return (
    <button onClick={() => navigate(to)} title={`Open the ${chip.kind}`} className={`${CHIP} ${CHIP_TONE[chip.kind]} hover:brightness-125`}>
      {chip.label}
    </button>
  );
}

/** A labelled list inside a model card ("Contract", "Breaking changes"). */
function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5 mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-500">
        {title}<span className="px-1.5 rounded-full bg-gray-800 tabular-nums normal-case tracking-normal text-gray-400">{count}</span>
      </div>
      <ul className="rounded border border-gray-700/60 divide-y divide-gray-700/50 bg-surface-app/50">{children}</ul>
    </div>
  );
}

function FindingItem({ finding }: { finding: ContractFinding }) {
  return (
    <li className="flex items-start gap-2 px-2.5 py-1.5">
      <span className={`${PILL} w-16 justify-center mt-px ${FINDING_PILL[finding.kind]}`}>{findingLabel(finding.kind)}</span>
      <span className="min-w-0 text-gray-300">
        {finding.column && <span className="font-mono text-gray-100">{finding.column} </span>}
        {findingDetail(finding)}
      </span>
    </li>
  );
}

function ChangeHeadline({ change }: { change: BreakingChange }) {
  if (change.change === 'renamed') {
    return <><span className="font-mono text-gray-100">{change.column}</span><span className="text-gray-500"> → </span><span className="font-mono text-gray-100">{change.to}</span></>;
  }
  if (change.change === 'retyped') {
    return <><span className="font-mono text-gray-100">{change.column}</span><span className="text-gray-400">: {change.from_type} → {change.to_type}</span></>;
  }
  return <span className="font-mono text-gray-100">{change.column}</span>;
}

function ChangeItem({ projectId, change, onNodeClick }: { projectId: number; change: BreakingChange; onNodeClick: NodeClick }) {
  const groups = consumerGroups(change.consumers);
  return (
    <li className="px-2.5 py-1.5">
      <div className="flex items-start gap-2">
        <span className={`${PILL} w-16 justify-center mt-px ${CHANGE_PILL[change.change]}`}>{change.change}</span>
        <span className="min-w-0 break-words"><ChangeHeadline change={change} /></span>
        <span className={`${PILL} ml-auto ${SEVERITY_PILL[change.severity]}`}>{change.severity}</span>
      </div>
      {groups.length === 0
        ? <p className="mt-1 pl-[4.5rem] text-gray-600">Nothing uses it.</p>
        : (
          <dl className="mt-1 pl-[4.5rem] grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1">
            {groups.map((g) => (
              <div key={g.label} className="contents">
                <dt className="pt-0.5 text-[11px] text-gray-500" title={g.label === 'Possibly' ? "Couldn't be traced, but its SQL mentions the column" : undefined}>
                  {g.label}
                </dt>
                <dd className="flex flex-wrap gap-1 min-w-0">
                  {g.chips.map((c, i) => <Chip key={i} projectId={projectId} chip={c} onNodeClick={onNodeClick} />)}
                </dd>
              </div>
            ))}
          </dl>
        )}
    </li>
  );
}

function ModelCard({ projectId, result, onNodeClick }: { projectId: number; result: ContractResult; onNodeClick: NodeClick }) {
  const tags = [result.contracted && 'contract enforced', result.versioned && 'versioned', result.access && `access: ${result.access}`,
    result.new_model && 'new model'].filter(Boolean) as string[];
  const changes = [...result.breaking_changes].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const added = result.column_diff?.added ?? [];
  return (
    <div className={`rounded-md border border-gray-800 border-l-2 ${SEVERITY_BAR[result.severity]} bg-surface-panel px-3 py-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={(e) => onNodeClick(e, result.unique_id)} title={OPEN_IN_FILES_TITLE}
          className={`flex items-center gap-1.5 font-mono text-[13px] text-gray-100 cursor-default mod:cursor-pointer ${OPEN_IN_FILES_HOVER_CLS}`}>
          <FileCode2 size={13} className="text-gray-500" />{result.name}
        </button>
        <span className={`${PILL} ${SEVERITY_PILL[result.severity]}`}>{result.severity === 'none' ? 'ok' : result.severity}</span>
        {tags.map((t) => <span key={t} className="px-1.5 rounded bg-gray-800/70 text-[10px] text-gray-400">{t}</span>)}
      </div>
      {result.contract_findings.length > 0 && (
        <Group title="Contract" count={result.contract_findings.length}>
          {result.contract_findings.map((f, i) => <FindingItem key={i} finding={f} />)}
        </Group>
      )}
      {changes.length > 0 && (
        <Group title="Column changes" count={changes.length}>
          {changes.map((c, i) => <ChangeItem key={i} projectId={projectId} change={c} onNodeClick={onNodeClick} />)}
        </Group>
      )}
      {added.length > 0 && (
        <p className="mt-2 text-gray-500">New columns: <span className="font-mono text-emerald-300/80 break-words">{added.join(', ')}</span></p>
      )}
      {!result.base_known && !result.new_model && (
        <p className="mt-2 text-gray-500">The base's columns couldn't be read, so only the contract was checked.</p>
      )}
      {result.suggestion && (
        <p className="flex items-start gap-1.5 mt-2 px-2.5 py-1.5 rounded bg-brand-900/20 text-brand-300/90">
          <Lightbulb size={12} className="mt-0.5 shrink-0" />{result.suggestion}
        </p>
      )}
    </div>
  );
}

/** Contract check findings: one card per changed model, worst first. */
export function ContractFindings({ projectId, results, onNodeClick }: { projectId: number; results: readonly ContractResult[]; onNodeClick: NodeClick }) {
  const shown = [...results]
    .filter((r) => r.severity !== 'none' || r.column_diff?.added.length)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.name.localeCompare(b.name));
  if (shown.length === 0) {
    return <p className="text-xs text-emerald-400/80">No breaking changes: every changed model keeps its columns and contract.</p>;
  }
  return (
    <div className="flex flex-col gap-2 text-xs">
      {shown.map((r) => <ModelCard key={r.unique_id} projectId={projectId} result={r} onNodeClick={onNodeClick} />)}
    </div>
  );
}
