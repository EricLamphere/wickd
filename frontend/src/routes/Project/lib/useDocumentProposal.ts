import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type DocumentResultDto } from '../../../lib/api';
import { aiApi, type AiProposalDto } from '../../../lib/aiApi';

/** What the stub-entries proposal adds ({path, created_file, added_entry, added_columns}). */
export const documentSummary = (p: AiProposalDto) => p.result.summary as unknown as DocumentResultDto;

/**
 * The docs generator with a review step: builds a `document_stub` proposal for the node
 * (warehouse columns, or `columns` when given), opens it for review when there's something
 * to add, and refetches it when the review closes so callers can show the outcome.
 * Render ProposalReviewModal while `reviewing` is set.
 */
export function useDocumentProposal(projectId: number, uniqueId: string, onApplied?: (p: AiProposalDto) => void) {
  const [proposal, setProposal] = useState<AiProposalDto | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const mutation = useMutation({
    mutationFn: (columns?: string[]) => api.models.proposeDocument(projectId, uniqueId, columns),
    onSuccess: (created) => {
      setProposal(created);
      setReviewing(created.status === 'ready');
    },
  });

  const closeReview = async () => {
    setReviewing(false);
    if (!proposal) return;
    const latest = await aiApi.proposal(projectId, proposal.id).catch(() => proposal);
    setProposal(latest);
    if (latest.status === 'applied') onApplied?.(latest);
  };

  return {
    start: (columns?: string[]) => mutation.mutate(columns),
    pending: mutation.isPending,
    error: mutation.error,
    proposal,
    reviewing,
    openReview: () => setReviewing(true),
    closeReview,
  };
}
