import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMerge, Loader2 } from 'lucide-react';
import { isProFeatureRequiredError } from '../../../../lib/api';
import { lineageNotReadyReason, propagationApi } from '../../../../lib/propagationApi';
import { useProjectEvents } from '../../../../lib/sse';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { UpgradeModal } from '../UpgradeModal';
import { ProposalReviewModal } from '../Wicky/ProposalReviewModal';
import { LineageNotReadyNotice } from './LineageNotReadyNotice';
import {
  PROPAGATION_FEATURE, PROPAGATION_STALE_EVENTS, retryUnlessSettled, useProEntitled, usePropagateProposal,
} from './usePropagation';

interface InheritDescriptionsButtonProps {
  projectId: number;
  /** One model (side pane); omitted for the whole project (Docs overview). */
  uniqueId?: string;
}

/**
 * "Fill descriptions from lineage (N)": proposes descriptions for empty columns
 * from their nearest documented pass-through upstream column, reviewed in the
 * proposal modal. With a `uniqueId` it covers that model only and shows only
 * when there's something to fill (the project-wide button on the Docs overview
 * carries the locked and lineage-not-ready states, so model panes stay quiet).
 */
export function InheritDescriptionsButton({ projectId, uniqueId }: InheritDescriptionsButtonProps) {
  const qc = useQueryClient();
  const { entitled, loading } = useProEntitled();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const proposal = usePropagateProposal(projectId);
  const queryKey = ['propagate-preview', projectId, uniqueId ?? null];

  useProjectEvents(projectId, useCallback((event) => {
    if (PROPAGATION_STALE_EVENTS.has(event.type)) qc.invalidateQueries({ queryKey: ['propagate-preview', projectId] });
  }, [projectId, qc]));

  const preview = useQuery({
    queryKey,
    queryFn: () => propagationApi.previewDescriptions(projectId, uniqueId),
    enabled: entitled,
    retry: retryUnlessSettled,
  });

  const label = uniqueId ? 'Inherit descriptions from upstream' : 'Fill descriptions from lineage';
  const locked = (!loading && !entitled) || isProFeatureRequiredError(preview.error) || proposal.locked;
  const notReady = lineageNotReadyReason(preview.error);
  const fillable = preview.data?.fillable ?? 0;
  const conflicts = preview.data?.conflicts ?? 0;

  if (loading) return null;
  if (uniqueId && (locked || notReady || fillable === 0)) return null;

  return (
    <div className="flex flex-col gap-1">
      {locked ? (
        <ProFeatureButton onClick={() => setUpgradeOpen(true)} title={`${label} (wickd Pro)`}>{label}</ProFeatureButton>
      ) : notReady ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">{label}</span>
          <LineageNotReadyNotice projectId={projectId} reason={notReady} compact />
        </div>
      ) : (
        <button
          onClick={() => proposal.start(() => propagationApi.propagateDescriptions(projectId, uniqueId ? [uniqueId] : undefined))}
          disabled={fillable === 0 || proposal.building || preview.isLoading}
          title={fillable === 0
            ? 'No empty description has a documented pass-through column upstream.'
            : 'Copies each empty column description from the nearest documented upstream column it passes through unchanged, renamed or cast. You review every change before anything is written.'}
          className={`flex items-center gap-1.5 rounded bg-surface-elevated border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-50 transition-colors ${
            uniqueId ? 'justify-center w-full py-2 text-sm' : 'self-start px-3 py-1.5 text-xs'
          }`}
        >
          {proposal.building || preview.isLoading ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />}
          {label}{preview.data ? ` (${fillable})` : ''}
        </button>
      )}
      {!locked && !notReady && conflicts > 0 && (
        <span className="text-[11px] text-gray-600" title="These columns get different descriptions from different upstream columns (e.g. a UNION), so they're left for you.">
          {conflicts} column{conflicts === 1 ? '' : 's'} skipped: upstream descriptions disagree
        </span>
      )}
      {proposal.notice && <span className="text-[11px] text-gray-500">{proposal.notice}</span>}
      {proposal.reviewing && (
        <ProposalReviewModal projectId={projectId} proposal={proposal.reviewing} onClose={proposal.closeReview} />
      )}
      {(upgradeOpen || proposal.locked) && (
        <UpgradeModal
          feature={PROPAGATION_FEATURE}
          onClose={() => { setUpgradeOpen(false); proposal.clearLocked(); }}
        />
      )}
    </div>
  );
}
