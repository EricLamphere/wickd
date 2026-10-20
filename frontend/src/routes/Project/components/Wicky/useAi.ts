import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { aiApi, type AiModelDownloadEvent, type AiProposalProgress } from '../../../../lib/aiApi';
import { useGlobalEvents, useProjectEvents } from '../../../../lib/sse';

const SETTLED_STATES = new Set(['done', 'error', 'cancelled']);

/** AI readiness (license, runtime, model) + live model download progress over the global SSE stream. */
export function useAiStatus() {
  const qc = useQueryClient();
  const [downloads, setDownloads] = useState<Record<string, AiModelDownloadEvent>>({});

  useGlobalEvents(useCallback((event) => {
    if (event.type !== 'ai_model_download') return;
    const data = event.data as AiModelDownloadEvent;
    setDownloads((prev) => ({ ...prev, [data.model_id]: data }));
    if (SETTLED_STATES.has(data.state)) qc.invalidateQueries({ queryKey: ['ai-status'] });
  }, [qc]));

  const query = useQuery({ queryKey: ['ai-status'], queryFn: aiApi.status });
  return { status: query.data ?? null, loading: query.isLoading, error: query.error, downloads };
}

/**
 * The project's active AI proposals (generating, ready, failed, nothing-to-do), plus the live
 * progress of the ones generating. Kept fresh by `ai_proposal_updated` / `ai_proposal_progress`.
 */
export function useAiProposals(projectId: number) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<Record<number, AiProposalProgress>>({});

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'ai_query_updated') {
      qc.invalidateQueries({ queryKey: ['ai-conversation', projectId] });
    }
    if (event.type === 'ai_proposal_progress') {
      const data = event.data as AiProposalProgress;
      setProgress((prev) => ({ ...prev, [data.proposal_id]: data }));
    }
    if (event.type === 'ai_proposal_updated') {
      qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
      qc.invalidateQueries({ queryKey: ['ai-conversation', projectId] });
      const { proposal_id, status } = event.data as { proposal_id: number; status: string };
      if (status !== 'generating') {
        setProgress(({ [proposal_id]: _done, ...rest }) => rest);
      }
    }
  }, [projectId, qc]));

  const query = useQuery({
    queryKey: ['ai-proposals', projectId],
    queryFn: () => aiApi.proposals(projectId),
  });
  return { proposals: query.data ?? [], progress };
}

/**
 * The open Wicky chat: defaults to the most recent one, and `ensure()` creates one on
 * first use so questions and quick actions always land in a conversation's history.
 */
export function useWickyConversation(projectId: number) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const conversations = useQuery({
    queryKey: ['ai-conversations', projectId],
    queryFn: () => aiApi.conversations(projectId),
  });
  const activeId = selectedId ?? conversations.data?.[0]?.id ?? null;

  const ensure = useCallback(async (): Promise<number> => {
    if (activeId !== null) return activeId;
    const created = await aiApi.createConversation(projectId);
    setSelectedId(created.id);
    qc.invalidateQueries({ queryKey: ['ai-conversations', projectId] });
    return created.id;
  }, [activeId, projectId, qc]);

  return { conversations: conversations.data ?? [], activeId, select: setSelectedId, ensure };
}
