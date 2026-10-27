import { useCallback, useEffect, useState } from 'react';
import { Eye, Loader2, Wand2, X } from 'lucide-react';
import { aiApi, type AiProposalDto } from '../../../../lib/aiApi';
import { alertDialog, promptDialog } from '../../../../lib/dialogs';
import { refactorApi } from '../../../../lib/refactorApi';
import { useProjectEvents } from '../../../../lib/sse';
import { START_REFACTOR_EVENT, type StartRefactorDetail } from '../../lib/refactorEvents';
import { usePropagateProposal } from '../propagation/usePropagation';
import { UpgradeModal } from '../UpgradeModal';
import { InlineCode } from '../Wicky/InlineCode';
import { ProposalReviewModal } from '../Wicky/ProposalReviewModal';
import { RefactorOutcome } from '../Wicky/RefactorOutcome';
import { nameProblem, refactorPrompt } from './refactorDialog';

const TOAST = 'fixed bottom-4 right-4 z-40 flex flex-col gap-2 w-96 max-w-[calc(100vw-2rem)] px-3 py-2.5 rounded-lg border border-gray-700 bg-surface-panel shadow-xl text-xs text-gray-300';

async function askName(detail: StartRefactorDetail): Promise<string | null> {
  const copy = refactorPrompt(detail);
  const current = detail.op === 'rename_column' ? detail.column ?? '' : detail.op === 'rename_model' ? detail.model : '';
  let name = copy.initial;
  for (;;) {
    const answer = await promptDialog(copy.message, name, { title: copy.title, confirmLabel: copy.confirm });
    if (answer === null) return null;
    const problem = nameProblem(answer, current);
    if (problem === null) return answer.trim();
    await alertDialog(problem, { title: copy.title });
    name = answer;
  }
}

/**
 * Runs refactors started from menus (startRefactor() in lib/refactorEvents.ts):
 * asks for the new name, builds the proposal, opens the review, and once it's
 * applied shows the dbt parse check with Undo. Mounted once in ProjectLayout.
 */
export function RefactorHost({ projectId }: { projectId: number }) {
  const flow = usePropagateProposal(projectId);
  const [outcome, setOutcome] = useState<AiProposalDto | null>(null);
  const [reopened, setReopened] = useState<AiProposalDto | null>(null);
  const reviewing = flow.reviewing ?? reopened;
  const { start } = flow;

  useEffect(() => {
    const onStart = async (e: Event) => {
      const detail = (e as CustomEvent<StartRefactorDetail>).detail;
      const newName = await askName(detail);
      if (newName === null) return;
      setOutcome(null);
      void start(() => refactorApi.start(projectId, {
        op: detail.op, unique_id: detail.uniqueId, new_name: newName, column: detail.column, cte: detail.cte,
      }));
    };
    window.addEventListener(START_REFACTOR_EVENT, onStart);
    return () => window.removeEventListener(START_REFACTOR_EVENT, onStart);
  }, [projectId, start]);

  // keep the outcome card current (the dbt parse check lands after applying)
  const outcomeId = outcome?.id ?? null;
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type !== 'ai_proposal_updated' || outcomeId === null) return;
    const { proposal_id } = event.data as { proposal_id: number };
    if (proposal_id === outcomeId) aiApi.proposal(projectId, outcomeId).then(setOutcome).catch(() => undefined);
  }, [outcomeId, projectId]));

  /** After the review closes: applied → the outcome card; still ready → a card to reopen it. */
  const closeReview = async () => {
    const reviewed = reviewing;
    flow.closeReview();
    setReopened(null);
    if (!reviewed) return;
    const latest = await aiApi.proposal(projectId, reviewed.id).catch(() => null);
    if (latest && (latest.status === 'applied' || latest.status === 'ready')) setOutcome(latest);
  };

  const discard = async (proposal: AiProposalDto) => {
    setOutcome(null);
    await aiApi.dismissProposal(projectId, proposal.id).catch(() => undefined);
  };

  return (
    <>
      {flow.building && (
        <div className={TOAST}>
          <span className="flex items-center gap-2"><Loader2 size={12} className="animate-spin text-brand-300" /> Preparing the refactor…</span>
        </div>
      )}
      {!flow.building && flow.notice && (
        <div className={TOAST}>
          <div className="flex items-start gap-2">
            <span className="flex-1 text-red-400 break-words">Couldn&rsquo;t refactor: {flow.notice}</span>
            <button onClick={flow.clearNotice} className="p-0.5 text-gray-500 hover:text-gray-300" title="Close"><X size={12} /></button>
          </div>
        </div>
      )}
      {!flow.building && !flow.notice && outcome && (
        <div className={TOAST}>
          <div className="flex items-start gap-2">
            <Wand2 size={12} className="mt-0.5 shrink-0 text-brand-300" />
            <span className="flex-1 break-words"><InlineCode text={outcome.title} /></span>
            <button onClick={() => setOutcome(null)} className="p-0.5 text-gray-500 hover:text-gray-300" title="Close"><X size={12} /></button>
          </div>
          {outcome.status === 'ready' ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-gray-500">Not applied yet.</span>
              <button onClick={() => discard(outcome)} className="px-2 py-1 text-gray-500 hover:text-gray-300">Discard</button>
              <button
                onClick={() => { setReopened(outcome); setOutcome(null); }}
                className="flex items-center gap-1 px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-500"
              >
                <Eye size={12} /> Review
              </button>
            </div>
          ) : (
            <RefactorOutcome projectId={projectId} proposal={outcome} onChange={setOutcome} />
          )}
        </div>
      )}
      {reviewing && <ProposalReviewModal projectId={projectId} proposal={reviewing} onClose={closeReview} />}
      {flow.locked && <UpgradeModal feature="Refactors" onClose={flow.clearLocked} />}
    </>
  );
}
