import { Eye, FilePlus2, Loader2 } from 'lucide-react';
import type { ModelNode } from '../../../../lib/api';
import { describeDocumentResult, documentErrorMessage } from '../../lib/documentModel';
import { documentSummary, useDocumentProposal } from '../../lib/useDocumentProposal';
import { ProposalReviewModal } from '../Wicky/ProposalReviewModal';

const DOCUMENTABLE_TYPES = new Set(['model', 'seed', 'snapshot']);

export function canDocument(model: ModelNode): boolean {
  return DOCUMENTABLE_TYPES.has(model.resource_type) && !!model.original_file_path;
}

interface DocumentModelButtonProps {
  projectId: number;
  model: ModelNode;
}

/**
 * Adds the node and all of its warehouse columns to the schema YAML in its
 * folder, after you review the change in the proposal review window (nothing is
 * written until you accept it). Mount with `key={model.unique_id}` so feedback
 * resets per node.
 */
export function DocumentModelButton({ projectId, model }: DocumentModelButtonProps) {
  const doc = useDocumentProposal(projectId, model.unique_id);
  const proposal = doc.proposal;

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => doc.start()}
        disabled={doc.pending}
        title="Add this node and its warehouse columns to the schema YAML in its folder; you review the change before it's written"
        className="flex items-center justify-center gap-2 w-full py-2 bg-surface-elevated border border-gray-700 rounded text-sm text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
      >
        {doc.pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <FilePlus2 className="w-4 h-4" />}
        {doc.pending ? 'Reading columns…' : 'Generate docs YAML'}
      </button>
      {proposal?.status === 'applied' && (
        <p className="text-[10px] text-emerald-400 break-all">{describeDocumentResult(documentSummary(proposal))}</p>
      )}
      {proposal?.status === 'empty' && (
        <p className="text-[10px] text-gray-400 break-all">{describeDocumentResult(documentSummary(proposal))}</p>
      )}
      {proposal?.status === 'rejected' && <p className="text-[10px] text-gray-500">Not written.</p>}
      {proposal?.status === 'ready' && !doc.reviewing && (
        <p className="flex items-center gap-1 text-[10px] text-gray-400">
          Not written yet.
          <button onClick={doc.openReview} className="inline-flex items-center gap-0.5 text-brand-300 hover:text-brand-200">
            <Eye className="w-3 h-3" /> Review
          </button>
        </p>
      )}
      {doc.error && <p className="text-[10px] text-red-400 break-all">{documentErrorMessage(doc.error)}</p>}
      {doc.reviewing && proposal && (
        <ProposalReviewModal projectId={projectId} proposal={proposal} onClose={doc.closeReview} />
      )}
    </div>
  );
}
