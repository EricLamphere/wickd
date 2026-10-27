import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Columns3, FileCode2, Filter, LayoutDashboard, Network, Rows3 } from 'lucide-react';
import type { TestGapCandidateDto, TestGapDto } from '../../../../lib/testGapsApi';
import { OPEN_IN_FILES_TITLE } from '../../lib/openInFiles';
import type { NodeFileNav } from '../NodeName';
import { TEST_LABEL } from './testGapsView';

const TEST_TONE: Record<string, string> = {
  not_null: 'bg-sky-950/40 text-sky-300 border-sky-900/60',
  unique: 'bg-violet-950/40 text-violet-300 border-violet-900/60',
  relationships: 'bg-teal-950/40 text-teal-300 border-teal-900/60',
  unique_combination_of_columns: 'bg-indigo-950/40 text-indigo-300 border-indigo-900/60',
};

/** One suggested test as a coloured pill; relationships show their target. */
export function TestPill({ candidate }: { candidate: TestGapCandidateDto }) {
  const target = candidate.test === 'relationships' && candidate.to
    ? `${candidate.to.split('.').pop()}.${candidate.field ?? ''}`
    : null;
  return (
    <span
      title={candidate.evidence}
      className={`inline-flex max-w-full items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10.5px] whitespace-nowrap ${
        TEST_TONE[candidate.test] ?? 'bg-surface-elevated text-gray-300 border-gray-700'
      }`}
    >
      {TEST_LABEL[candidate.test] ?? candidate.test}
      {target && <span className="min-w-0 truncate opacity-75">→ {target}</span>}
    </span>
  );
}

export function TestPills({ candidates }: { candidates: TestGapCandidateDto[] }) {
  if (candidates.length === 0) return <span className="text-gray-600">—</span>;
  return <span className="flex flex-wrap gap-1">{candidates.map((c) => <TestPill key={c.test} candidate={c} />)}</span>;
}

/** The column (or column combination) on top, its model underneath (Cmd+click opens it in Files). */
export function GapSubject({ uniqueId, model, label, fileNav }: {
  uniqueId: string;
  model: string;
  label: string;
  fileNav: NodeFileNav;
}) {
  const openable = fileNav.canOpen(uniqueId);
  return (
    <span className="flex flex-col min-w-0">
      <span className="truncate font-mono text-[12px] text-gray-100" title={label}>{label}</span>
      <span
        onClick={(e) => fileNav.handleClick(e, uniqueId)}
        title={openable ? OPEN_IN_FILES_TITLE : undefined}
        className={`truncate font-mono text-[10.5px] text-gray-500 ${
          openable ? 'mod:cursor-pointer mod:underline mod:text-brand-300 underline-offset-2' : ''
        }`}
      >
        {model}
      </span>
    </span>
  );
}

/** What depends on the column, as small icon counts. */
export function GapUse({ row }: { row: Pick<TestGapDto, 'reach' | 'row_uses' | 'exposures' | 'in_grain'> }) {
  const items = [
    { show: row.reach > 0, icon: <Columns3 size={11} />, value: row.reach, title: `${row.reach} downstream column${row.reach === 1 ? '' : 's'} built from it` },
    { show: row.row_uses > 0, icon: <Filter size={11} />, value: row.row_uses, title: `${row.row_uses} model${row.row_uses === 1 ? '' : 's'} filter, join or group on it` },
    { show: row.exposures > 0, icon: <LayoutDashboard size={11} />, value: row.exposures, title: `reaches ${row.exposures} exposure${row.exposures === 1 ? '' : 's'}` },
  ].filter((i) => i.show);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-400">
      {items.map((i) => (
        <span key={i.title} title={i.title} className="inline-flex items-center gap-1 tabular-nums whitespace-nowrap">
          <span className="text-gray-500">{i.icon}</span>{i.value}
        </span>
      ))}
      {row.in_grain && (
        <span title="Part of the model’s grain (what one row is unique on)" className="inline-flex items-center gap-1 px-1.5 rounded bg-surface-elevated text-[10px] text-gray-300">
          <Rows3 size={10} /> grain
        </span>
      )}
      {items.length === 0 && !row.in_grain && <span className="text-gray-600">—</span>}
    </span>
  );
}

/** Expanded row: each suggested test with its full evidence, the models involved, and where to go. */
export function GapDetail({ projectId, uniqueId, model, candidates, fileNav, actions }: {
  projectId: number;
  uniqueId: string;
  model: string;
  candidates: TestGapCandidateDto[];
  fileNav: NodeFileNav & { open: (uniqueId: string) => void };
  /** Row actions shown after the navigation buttons (e.g. Ignore, then Generate these tests). */
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
      <ul className="flex-1 min-w-[18rem] flex flex-col gap-3">
        {candidates.length === 0 && <li className="text-xs text-gray-500">Nothing would be suggested for it now.</li>}
        {candidates.map((c) => (
          <li key={c.test} className="flex flex-col items-start gap-1">
            <TestPill candidate={c} />
            <span className="flex flex-col gap-1 pl-0.5 text-xs">
              <span className="text-gray-300">{c.evidence}</span>
              {c.models.length > 0 && (
                <span className="flex flex-wrap items-center gap-1 text-[11px] text-gray-500">
                  joined in
                  {c.models.map((m) => (
                    <span key={m} className="px-1.5 rounded bg-surface-elevated font-mono text-gray-300">{m}</span>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5">
        {fileNav.canOpen(uniqueId) && (
          <button
            type="button"
            onClick={() => fileNav.open(uniqueId)}
            title={`Open ${model} in Files`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-gray-700 text-[11px] text-gray-300 hover:bg-surface-elevated"
          >
            <FileCode2 size={12} /> Open in Files
          </button>
        )}
        <button
          type="button"
          onClick={() => navigate(`/projects/${projectId}/models?model=${encodeURIComponent(uniqueId)}`)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-gray-700 text-[11px] text-gray-300 hover:bg-surface-elevated"
        >
          <Network size={12} /> Show in DAG
        </button>
        {actions}
      </div>
    </div>
  );
}

/** A labelled button for GapDetail's action row (brand = the primary action). */
export function DetailAction({ icon, label, onClick, disabled = false, brand = false }: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  brand?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors disabled:opacity-50 ${
        brand
          ? 'bg-brand-600 text-white hover:bg-brand-500'
          : 'border border-gray-700 text-gray-300 hover:bg-surface-elevated'
      }`}
    >
      {icon} {label}
    </button>
  );
}
