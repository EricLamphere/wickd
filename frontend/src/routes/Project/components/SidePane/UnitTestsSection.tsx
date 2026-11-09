// The side pane's Unit tests section (plan 19): a model's dbt unit tests with their last
// status, run them, see a failure's expected-vs-actual rows, accept the actual rows as the
// new expectation (Base), or have Wicky draft a new one (Pro).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, CheckCheck, FileText, FlaskRound, Loader2, Play } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { api, type GraphDto, type ModelNode, type UnitTestDto } from '../../../../lib/api';
import { aiApi, aiErrorMessage, type AiProposalDto } from '../../../../lib/aiApi';
import { useProEntitled } from '../../RunHistory/usePerformance';
import { FAILED, diffCounts, diffDisplay, unitTestSelector, unitTestsOf } from '../../lib/unitTests';
import { openWicky, type FocusHint } from '../../lib/wickyEvents';
import { UpgradeModal } from '../UpgradeModal';
import { ProposalReviewModal } from '../Wicky/ProposalReviewModal';

export const UNIT_TEST_FEATURE = 'Unit test generation';

/** Last result as a chip after the test's name; nothing until it has run. */
const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  success: { label: 'pass', className: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60' },
  pass: { label: 'pass', className: 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60' },
  error: { label: 'fail', className: 'bg-red-950/40 text-red-300 border-red-900/60' },
  fail: { label: 'fail', className: 'bg-red-950/40 text-red-300 border-red-900/60' },
  warn: { label: 'warn', className: 'bg-yellow-950/40 text-yellow-300 border-yellow-900/60' },
};

function StatusChip({ status }: { status: string | undefined }) {
  const chip = STATUS_CHIP[status ?? ''];
  if (!chip) return null;
  return (
    <span className={`shrink-0 px-1.5 rounded border text-[10px] leading-4 font-medium ${chip.className}`}>
      {chip.label}
    </span>
  );
}
const SMALL = 'flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-gray-400 hover:text-brand-300 hover:bg-gray-800 disabled:opacity-40';

interface Props {
  projectId: number;
  model: ModelNode;
  graph: GraphDto | null;
}

/** Wicky drafts a unit test for `uniqueId` (opens its options: focus, masking). */
export function startUnitTest(uniqueId: string, focusHint?: FocusHint): void {
  openWicky({ uniqueId, action: 'unit_test', focusHint });
}

function AddUnitTestButton({ model }: { model: ModelNode }) {
  const { entitled, loading } = useProEntitled();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  if (loading) return null;
  const title = 'Wicky samples real rows that hit each branch, runs the model on them and proposes a unit test to review';
  return (
    <>
      {entitled ? (
        <button onClick={() => startUnitTest(model.unique_id)} title={title} className={SMALL}>
          <FlaskRound size={11} />Add unit test…
        </button>
      ) : (
        <ProFeatureButton onClick={() => setUpgradeOpen(true)} title={`${title} (wickd Pro)`} className="!px-2 !py-1">
          Add unit test
        </ProFeatureButton>
      )}
      {upgradeOpen && <UpgradeModal feature={UNIT_TEST_FEATURE} onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

function FailureView({ projectId, unit }: { projectId: number; unit: UnitTestDto }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<AiProposalDto | null>(null);
  const diff = unit.diff;

  const rebaseline = async () => {
    setBusy(true);
    setError(null);
    try {
      setProposal(await aiApi.rebaselineUnitTest(projectId, unit.unique_id));
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!diff) {
    return <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-red-300/90">{unit.message ?? 'Failed'}</pre>;
  }
  const display = diffDisplay(diff);
  const counts = diffCounts(diff);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-gray-500">
        {[counts.changed && `${counts.changed} changed`, counts.added && `${counts.added} only in actual`,
          counts.removed && `${counts.removed} only in expected`].filter(Boolean).join(' · ') || 'Rows differ'}
        {diff.schema_changed && ' · columns differ'}
        {diff.elided && ' · unchanged rows hidden'}
      </span>
      <div className="max-h-48 overflow-auto rounded border border-gray-800">
        <DataTable
          columns={display.columns.map((c) => ({ key: c }))}
          rows={display.rows}
          cellClassName={(r, c) => display.classes[r]?.[c] || undefined}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={rebaseline}
          disabled={busy || diff.schema_changed}
          title="Propose replacing the test's expected rows with what the model produced; review it first"
          className={SMALL}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <CheckCheck size={11} />}Accept actual as expected…
        </button>
        <span className="text-[11px] text-gray-600">or fix the model</span>
      </div>
      {error && <span className="text-[11px] text-red-400 break-words">{error}</span>}
      {proposal && <ProposalReviewModal projectId={projectId} proposal={proposal} onClose={() => setProposal(null)} />}
    </div>
  );
}

function UnitTestRow({ projectId, unit, running, onRun }: {
  projectId: number;
  unit: UnitTestDto;
  running: boolean;
  onRun: () => void;
}) {
  const navigate = useNavigate();
  const failed = FAILED.has(unit.status ?? '');
  const [open, setOpen] = useState(failed);
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 min-w-0 text-left" aria-expanded={open}>
          <ChevronRight className={`w-3 h-3 shrink-0 text-gray-600 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="truncate font-mono text-[11px] text-gray-300">{unit.name}</span>
          <StatusChip status={unit.status} />
        </button>
        <span className="ml-auto flex items-center shrink-0">
          {unit.original_file_path && (
            <button
              // ?model=<unit test> opens its YAML scrolled to the test (FileExplorer → findUnitTestLine)
              onClick={() => navigate(`/projects/${projectId}/files?model=${encodeURIComponent(unit.unique_id)}`)}
              className={SMALL}
              title={`Open ${unit.original_file_path}`}
            >
              <FileText size={11} />
            </button>
          )}
          <button onClick={onRun} disabled={running} className={SMALL} title="Run this unit test">
            {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          </button>
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-1 pl-5">
          {unit.description && <span className="text-[11px] text-gray-500">{unit.description}</span>}
          <span className="text-[11px] text-gray-600">
            given {(unit.inputs ?? []).join(', ') || '—'}
            {unit.expect_rows != null && ` · expects ${unit.expect_rows} row${unit.expect_rows === 1 ? '' : 's'}`}
            {unit.has_overrides && ' · overrides'}
          </span>
          {failed && <FailureView projectId={projectId} unit={unit} />}
        </div>
      )}
    </li>
  );
}

export function UnitTestsSection({ projectId, model, graph }: Props) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (model.resource_type !== 'model') return null;
  const units = unitTestsOf(graph, model);
  const failing = units.filter((u) => FAILED.has(u.status ?? '')).length;

  const run = async (key: string, select: string) => {
    setRunning(key);
    setError(null);
    try {
      await api.runs.test(projectId, model.name, 'only', undefined, select);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the run');
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="flex flex-col gap-0.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-600 font-medium hover:text-gray-400 transition-colors"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        Unit tests
        <span className="px-1.5 rounded-full bg-gray-800 normal-case tracking-normal tabular-nums text-gray-400">
          {units.length}
        </span>
        {failing > 0 && (
          <span className="px-1.5 rounded-full bg-red-950/40 normal-case tracking-normal tabular-nums text-red-300">
            {failing} failing
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 mt-0.5">
          <span className="flex items-center gap-1">
            {units.length > 0 && (
              <button onClick={() => run('all', unitTestSelector(model.name))} disabled={running !== null} className={SMALL}
                title={`dbt test --select ${unitTestSelector(model.name)}`}>
                {running === 'all' ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}Run all
              </button>
            )}
            <AddUnitTestButton model={model} />
          </span>
          {units.length === 0
            ? <span className="text-[11px] text-gray-600">None yet. Unit tests check the model’s logic on fixed input rows.</span>
            : (
              <ul className="flex flex-col gap-1.5">
                {units.map((u) => (
                  <UnitTestRow
                    key={u.unique_id}
                    projectId={projectId}
                    unit={u}
                    running={running === u.unique_id}
                    onRun={() => run(u.unique_id, unitTestSelector(u.name))}
                  />
                ))}
              </ul>
            )}
          {error && <span className="text-[11px] text-red-400 break-words">{error}</span>}
        </div>
      )}
    </div>
  );
}
