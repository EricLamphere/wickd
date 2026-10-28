import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Boxes, FlaskConical, Loader2, Sparkles, Stethoscope, Wand2 } from 'lucide-react';
import type { ModelNode } from '../../../../lib/api';
import { aiApi, aiErrorMessage, type AiProposalDto } from '../../../../lib/aiApi';
import { semanticErrorBody, type SemanticStatusDto } from '../../../../lib/semanticApi';
import type { WickyAction } from '../../lib/wickyEvents';
import { canDocument } from '../SidePane/DocumentModelButton';
import { MetricflowBlockedNotice } from '../semantic/MetricflowBlockedNotice';

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
  /** Switch the chat to Refactor mode (rename a model or column, extract a CTE). */
  onRefactor: () => void;
  /** The model already has a semantic model (no "Add to semantic layer"). */
  inSemanticLayer: boolean;
  /** An action another page asked for (openWicky({ action })); started once per nonce. */
  autoStart: { nonce: number; action: WickyAction } | null;
}

type ProposalKind = 'document' | 'tests' | 'semantic';

const DOCUMENT_OPTIONS = [
  {
    overwrite: false,
    label: 'Fill in missing',
    description: 'Only describe the model and columns that don\u2019t have a description yet. Existing descriptions stay as they are.',
  },
  {
    overwrite: true,
    label: 'Rewrite all',
    description: 'Write new descriptions for everything, replacing existing ones. You\u2019ll review every change before it\u2019s saved.',
  },
] as const;

const BUTTON = 'flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-elevated border border-gray-700 text-gray-200 hover:bg-gray-700 disabled:opacity-50';

/** One-click Wicky actions for the selected node. Results appear in the chat below. */
export function QuickActions({
  projectId, model, proposals, ensureConversation, failing, onExplainFailure, onRefactor, inSemanticLayer, autoStart,
}: QuickActionsProps) {
  const qc = useQueryClient();
  const [choosing, setChoosing] = useState(false);
  const [starting, setStarting] = useState<ProposalKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<SemanticStatusDto | null>(null);
  const started = useRef<number | null>(null);

  const busy = (kind: ProposalKind) => starting === kind || proposals.some(
    (p) => p.kind === kind && p.unique_id === model.unique_id && p.status === 'generating',
  );

  const run = async (kind: ProposalKind, overwrite = false) => {
    setChoosing(false);
    setStarting(kind);
    setError(null);
    setBlocked(null);
    try {
      const conversationId = await ensureConversation();
      if (kind === 'document') await aiApi.document(projectId, model.unique_id, overwrite, conversationId);
      else if (kind === 'semantic') await aiApi.semanticDraft(projectId, model.unique_id, conversationId);
      else await aiApi.addTests(projectId, model.unique_id, conversationId);
      qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
      qc.invalidateQueries({ queryKey: ['ai-conversation', projectId, conversationId] });
      qc.invalidateQueries({ queryKey: ['ai-conversations', projectId] });
    } catch (err) {
      const status = semanticErrorBody(err)?.status;
      if (status) setBlocked(status);
      else setError(aiErrorMessage(err));
    } finally {
      setStarting(null);
    }
  };

  useEffect(() => {
    if (!autoStart || started.current === autoStart.nonce) return;
    started.current = autoStart.nonce;
    if (autoStart.action === 'semantic_draft') void run('semantic');
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = canDocument(model);
  const canDraftSemantic = model.resource_type === 'model' && !inSemanticLayer;
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
              onClick={() => setChoosing((v) => !v)}
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
            {canDraftSemantic && (
              <button
                onClick={() => run('semantic')}
                disabled={busy('semantic')}
                title="Draft a semantic model and starting metrics for this model, validated with MetricFlow and run against the warehouse; review them before anything is saved"
                className={BUTTON}
              >
                {busy('semantic') ? <Loader2 size={12} className="animate-spin text-brand-300" /> : <Boxes size={12} className="text-brand-300" />}
                {busy('semantic') ? 'Drafting metrics…' : 'Add to semantic layer'}
              </button>
            )}
            {model.resource_type === 'model' && (
              <button
                onClick={onRefactor}
                title="Rename this model or one of its columns everywhere, or extract a CTE into its own model; you review every edit"
                className={BUTTON}
              >
                <Wand2 size={12} className="text-brand-300" /> Refactor…
              </button>
            )}
          </>
        )}
      </div>
      {choosing && (
        <div
          className="flex flex-col gap-1.5 p-2 rounded border border-gray-700 bg-surface-elevated/60"
          onKeyDown={(e) => { if (e.key === 'Escape') setChoosing(false); }}
        >
          <span className="text-gray-400">What should Wicky document?</span>
          {DOCUMENT_OPTIONS.map((option, i) => (
            <button
              key={option.label}
              autoFocus={i === 0}
              onClick={() => run('document', option.overwrite)}
              className="flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded border border-gray-700 text-left hover:border-brand-600 hover:bg-gray-800 focus:outline-none focus:border-brand-500"
            >
              <span className="font-medium text-gray-200">{option.label}</span>
              <span className="text-gray-500">{option.description}</span>
            </button>
          ))}
          <button onClick={() => setChoosing(false)} className="self-end px-2 py-0.5 text-gray-500 hover:text-gray-300">
            Cancel
          </button>
        </div>
      )}
      {error && <span className="text-red-400 break-words">{error}</span>}
      {blocked && <MetricflowBlockedNotice projectId={projectId} status={blocked} onResolved={() => setBlocked(null)} />}
    </div>
  );
}
