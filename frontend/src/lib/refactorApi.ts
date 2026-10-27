// Typed helpers for refactors (wickd Pro): rename a model or column, extract a CTE.
// Proposals they create are reviewed and applied through aiApi (proposal routes).
import { post } from './api';
import type { AiMessageDto, AiProposalDto, RefactorOperation } from './aiApi';

export interface StartRefactorBody extends RefactorOperation {
  /** record it in this Wicky chat's history */
  conversation_id?: number | null;
  /** the Wicky confirm card it came from */
  message_id?: number | null;
}

export const refactorApi = {
  /** Build the refactor's proposal in the background; follow it via `ai_proposal_updated`. */
  start: (projectId: number, body: StartRefactorBody) =>
    post<AiProposalDto>(`/projects/${projectId}/refactor`, body),
  /** Wicky turns a request into one operation; returns [request, refactor card] messages. */
  parseRequest: (projectId: number, conversationId: number, body: { content: string; unique_id: string | null }) =>
    post<AiMessageDto[]>(`/projects/${projectId}/ai/conversations/${conversationId}/refactor`, body),
  cancel: (projectId: number, messageId: number) =>
    post<AiMessageDto>(`/projects/${projectId}/ai/messages/${messageId}/refactor/cancel`),
};
