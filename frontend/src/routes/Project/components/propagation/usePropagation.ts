import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, isProFeatureRequiredError } from '../../../../lib/api';
import { aiApi, aiErrorMessage, type AiProposalDto } from '../../../../lib/aiApi';
import { lineageNotReadyReason } from '../../../../lib/propagationApi';
import { useProjectEvents } from '../../../../lib/sse';

export const PROPAGATION_FEATURE = 'Lineage propagation';

export { useProEntitled } from '../../RunHistory/usePerformance';

/** Never retry a locked or not-ready answer: neither changes until an event says so. */
export const retryUnlessSettled = (count: number, err: unknown) =>
  !isProFeatureRequiredError(err) && lineageNotReadyReason(err) === null && !(err instanceof ApiError && err.status === 503) && count < 2;

/** The data propagation reads changed: lineage re-traced, YAML edited, manifest rebuilt, a proposal applied. */
export const PROPAGATION_STALE_EVENTS = new Set([
  'column_lineage_finished', 'graph_changed', 'files_changed', 'ai_proposal_updated',
]);

/**
 * Start a "propagate" proposal and follow it: while it builds `building` is set,
 * and once it's ready `reviewing` holds it for ProposalReviewModal. Nothing to
 * do / failures land in `notice`.
 */
export function usePropagateProposal(projectId: number) {
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState<AiProposalDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const settle = useCallback((proposal: AiProposalDto) => {
    if (proposal.status === 'generating') return;
    setPendingId(null);
    if (proposal.status === 'ready') setReviewing(proposal);
    else setNotice(proposal.error_message ?? `Nothing to review (${proposal.status}).`);
  }, []);

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type !== 'ai_proposal_updated' || pendingId === null) return;
    const { proposal_id } = event.data as { proposal_id: number };
    if (proposal_id !== pendingId) return;
    aiApi.proposal(projectId, proposal_id).then(settle).catch((err) => {
      setPendingId(null);
      setNotice(aiErrorMessage(err));
    });
  }, [pendingId, projectId, settle]));

  const start = useCallback(async (create: () => Promise<AiProposalDto>) => {
    setNotice(null);
    try {
      const proposal = await create();
      qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
      if (proposal.status !== 'generating') {
        settle(proposal);
        return;
      }
      setPendingId(proposal.id);
      // it may have finished before we started listening for its event
      const latest = await aiApi.proposal(projectId, proposal.id);
      if (latest.status !== 'generating') settle(latest);
    } catch (err) {
      if (isProFeatureRequiredError(err)) setLocked(true);
      else setNotice(aiErrorMessage(err));
    }
  }, [projectId, qc, settle]);

  return {
    start,
    building: pendingId !== null,
    reviewing,
    closeReview: () => setReviewing(null),
    notice,
    clearNotice: () => setNotice(null),
    locked,
    clearLocked: () => setLocked(false),
  };
}
