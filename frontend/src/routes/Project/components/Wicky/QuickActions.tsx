import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Loader2, Sparkles, Stethoscope } from 'lucide-react';
import type { ModelNode } from '../../../../lib/api';
import { aiApi, aiErrorMessage, type AiProposalDto } from '../../../../lib/aiApi';
import { canDocument } from '../SidePane/DocumentModelButton';

interface QuickActionsProps {
  projectId: number;
  model: ModelNode;
  /** The project's active proposals; their progress and results show in the chat. */
  proposals: AiProposalDto[];
  /** The open chat (created if needed), so the action is recorded in its history. */
  ensureConversation: () => Promise<number>;
  /** The node or one of its tests failed in the latest run. */
  failing: boolean;
  onExplainFailure: () => void;
}

type ProposalKind = 'document' | 'tests';

const BUTTON = 'flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-elevated border border-gray-700 text-gray-200 hover:bg-gray-700 disabled:opacity-50';

/** One-click Wicky actions for the selected node. Results appear in the chat below. */
export function QuickActions({
  projectId, model, proposals, ensureConversation, failing, onExplainFailure,
}: QuickActionsProps) {
  const qc = useQueryClient();
  const [overwrite, setOverwrite] = useState(false);
  const [starting, setStarting] = useState<ProposalKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = (kind: ProposalKind) => starting === kind || proposals.some(
    (p) => p.kind === kind && p.unique_id === model.unique_id && p.status === 'generating',
  );

  const run = async (kind: ProposalKind) => {
    setStarting(kind);
    setError(null);
    try {
      const conversationId = await ensureConversation();
      if (kind === 'document') await aiApi.document(projectId, model.unique_id, overwrite, conversationId);
      else await aiApi.addTests(projectId, model.unique_id, conversationId);
      qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
      qc.invalidateQueries({ queryKey: ['ai-conversation', projectId, conversationId] });
      qc.invalidateQueries({ queryKey: ['ai-conversations', projectId] });
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setStarting(null);
    }
  };

  const editable = canDocument(model);
  if (!editable && !failing) return null;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 border-b border-gray-800 text-xs shrink-0">
      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Quick actions</span>
      <div className="flex flex-wrap items-center gap-2">
        {failing && (
          <button
            onClick={onExplainFailure}
            title="Explain why this failed in the latest run, and how to fix it"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-950/40 border border-amber-800/60 text-amber-300 hover:bg-amber-900/40"
          >
            <Stethoscope size={12} /> Explain failure
          </button>
        )}
        {editable && (
          <>
            <button
              onClick={() => run('document')}
              disabled={busy('document')}
              title="Write descriptions for this node and its columns; review them before anything is saved"
              className={BUTTON}
            >
              {busy('document') ? <Loader2 size={12} className="animate-spin text-brand-300" /> : <Sparkles size={12} className="text-brand-300" />}
              {busy('document') ? 'Documenting…' : 'Document'}
            </button>
            <button
              onClick={() => run('tests')}
              disabled={busy('tests')}
              title="Suggest data tests from the SQL and a sample of the data, checked against the warehouse; review them before anything is saved"
              className={BUTTON}
            >
              {busy('tests') ? <Loader2 size={12} className="animate-spin text-brand-300" /> : <FlaskConical size={12} className="text-brand-300" />}
              {busy('tests') ? 'Adding tests…' : 'Add tests'}
            </button>
          </>
        )}
      </div>
      {editable && (
        <label className="flex items-center gap-1 text-gray-500 cursor-pointer self-start">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          Document: replace existing descriptions
        </label>
      )}
      {error && <span className="text-red-400 break-words">{error}</span>}
    </div>
  );
}
