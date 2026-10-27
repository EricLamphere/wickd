import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Check, Info, Loader2, Wand2 } from 'lucide-react';
import { aiErrorMessage, type AiMessageDto, type RefactorPayload } from '../../../../lib/aiApi';
import { refactorApi } from '../../../../lib/refactorApi';
import { InlineCode } from './InlineCode';

interface RefactorCardProps {
  projectId: number;
  conversationId: number;
  message: AiMessageDto;
}

/**
 * The refactor Wicky understood from a request, shown for confirmation. Nothing is
 * changed until Confirm; then the proposal appears below as an action entry.
 */
export function RefactorCard({ projectId, conversationId, message }: RefactorCardProps) {
  const qc = useQueryClient();
  const payload = message.payload as RefactorPayload;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ai-conversation', projectId, conversationId] });
    qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
  };

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => act(() => refactorApi.start(projectId, {
    ...payload.operation!, conversation_id: conversationId, message_id: message.id,
  }));
  const cancel = () => act(() => refactorApi.cancel(projectId, message.id));

  if (payload.status === 'none' || !payload.operation) {
    return (
      <div className="flex items-start gap-2 text-gray-400">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span className="break-words">{payload.reason ?? message.content}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg border border-gray-800 bg-surface-elevated/40 text-gray-300">
      <span className="flex items-start gap-2">
        <Wand2 size={12} className="mt-0.5 shrink-0 text-brand-300" />
        <span className="break-words"><InlineCode text={payload.description} /></span>
      </span>
      {payload.status === 'proposed' && (
        <>
          <span className="text-gray-500">
            wickd prepares every edit for you to review. Nothing is written until you apply it.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={confirm}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Prepare refactor
            </button>
            <button onClick={cancel} disabled={busy} className="px-2 py-1 text-gray-500 hover:text-gray-300 disabled:opacity-50">
              Cancel
            </button>
          </div>
        </>
      )}
      {payload.status === 'cancelled' && (
        <span className="flex items-center gap-1.5 text-gray-500"><Ban size={12} /> Cancelled</span>
      )}
      {error && <span className="text-red-400 break-words">{error}</span>}
    </div>
  );
}
