// Typed helpers for the AI routes (wickd Pro). Kept out of api.ts, which is
// already past the file-size limit; same request helpers and error type.
import { ApiError, del, get, post, put } from './api';

export interface AiModelDto {
  id: string;
  label: string;
  description: string;
  size_bytes: number;
  license: string;
  downloaded: boolean;
  downloading: boolean;
  bytes_done: number;
  error: string | null;
}

export interface AiStatusDto {
  entitled: boolean;
  pro_installed: boolean;
  runtime_installed: boolean;
  uses_endpoint: boolean;
  endpoint_url: string | null;
  endpoint_model: string | null;
  model_id: string;
  running_model_id: string | null;
  models: AiModelDto[];
  ready: boolean;
}

export interface AiModelDownloadEvent {
  model_id: string;
  state: 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
  bytes_done: number;
  bytes_total: number;
  error: string | null;
}

export interface AiMessageDto {
  id: number;
  /**
   * `action`: a quick action (e.g. Document) run from this chat; `proposal` holds its outcome.
   * `query`: SQL Wicky wrote (content = its explanation); `payload` holds it and its results.
   */
  role: 'user' | 'assistant' | 'action' | 'query';
  content: string;
  unique_id: string | null;
  created_at: string;
  proposal: AiProposalDto | null;
  payload: AiQueryPayload | null;
}

export type AiQueryStatus = 'proposed' | 'invalid' | 'waiting' | 'running' | 'done' | 'error';

export interface AiQueryPayload {
  question: string;
  sql: string;
  explanation: string;
  status: AiQueryStatus;
  error: string | null;
  columns?: string[] | null;
  rows?: unknown[][] | null;
  /** more rows existed than the row limit */
  truncated?: boolean;
}

export interface AiConversationDto {
  id: number;
  title: string;
  updated_at: string;
}

export interface AiConversationDetailDto extends AiConversationDto {
  messages: AiMessageDto[];
}

export interface AiProposalFileDto {
  id: number;
  path: string;
  /** null when the file doesn't exist yet */
  original_text: string | null;
  proposed_text: string;
  status: 'pending' | 'accepted' | 'rejected';
}

/** `empty`: nothing needed changing (error_message holds a note, not a failure). */
export interface AiSuggestedTest {
  key?: string;
  column: string;
  test: 'not_null' | 'unique' | 'accepted_values' | 'relationships';
  reason: string;
  values?: string[];
  to?: string;
  field?: string;
  failures?: number | null;
}

export type AiProposalStatus = 'generating' | 'ready' | 'applied' | 'rejected' | 'dismissed' | 'error' | 'empty';

/** `ai_proposal_progress` event: what generation is doing, and the model's answer so far. */
export interface AiProposalProgress {
  proposal_id: number;
  unique_id: string | null;
  phase: 'columns' | 'writing' | '';
  text: string;
}

export interface AiProposalDto {
  id: number;
  kind: string;
  unique_id: string | null;
  title: string;
  status: AiProposalStatus;
  error_message: string | null;
  created_at: string;
  /** What the AI produced, kept for chat history. */
  result: {
    /** kind "document" */
    description: string | null;
    columns: Record<string, string>;
    /** kind "tests"; failures = failing rows when pre-checked against the warehouse, null if not checked */
    tests: AiSuggestedTest[];
    /** Item keys included in the file ("t0"…, "description", "col:<name>"); null = all. */
    selected: string[] | null;
    /** Items already accepted in review (applied when the file is). */
    accepted: string[];
  };
  files: AiProposalFileDto[];
}

/** explain_failure: diagnose the node's latest failed run/tests (needs a unique_id). */
export type AskMode = 'ask' | 'explain_failure';

export interface AskHandlers {
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

/** Outcome of a streamed answer: finished, or an error message from the model server. */
export type AskResult = { ok: true } | { ok: false; error: string };

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      try {
        onEvent(event, data ? JSON.parse(data) : {});
      } catch {
        // malformed block — skip it
      }
    }
  }
}

async function streamPost(path: string, body: unknown, { onDelta, signal }: AskHandlers): Promise<AskResult> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    let parsed: unknown = null;
    try { parsed = JSON.parse(text)?.detail ?? null; } catch { /* not JSON */ }
    throw new ApiError(res.status, text, parsed);
  }
  let result: AskResult = { ok: true };
  await readEventStream(res.body, (event, data) => {
    if (event === 'delta' && typeof data.text === 'string') onDelta(data.text);
    if (event === 'error') result = { ok: false, error: String(data.message ?? 'The model failed to answer.') };
  });
  return result;
}

function ask(
  projectId: number,
  conversationId: number,
  body: { content: string; unique_id: string | null; mode?: AskMode },
  handlers: AskHandlers,
): Promise<AskResult> {
  return streamPost(`/projects/${projectId}/ai/conversations/${conversationId}/messages`, body, handlers);
}

export const aiApi = {
  status: () => get<AiStatusDto>('/ai/status'),
  downloadModel: (modelId: string) => post<AiModelDto>(`/ai/models/${modelId}/download`),
  cancelDownload: (modelId: string) => del<AiModelDto>(`/ai/models/${modelId}/download`),
  deleteModel: (modelId: string) => del<AiModelDto>(`/ai/models/${modelId}`),

  conversations: (projectId: number) =>
    get<AiConversationDto[]>(`/projects/${projectId}/ai/conversations`),
  createConversation: (projectId: number) =>
    post<AiConversationDetailDto>(`/projects/${projectId}/ai/conversations`),
  conversation: (projectId: number, id: number) =>
    get<AiConversationDetailDto>(`/projects/${projectId}/ai/conversations/${id}`),
  deleteConversation: (projectId: number, id: number) =>
    del<void>(`/projects/${projectId}/ai/conversations/${id}`),
  ask,
  /** Query data: Wicky writes a SELECT (not run yet). Returns [question, query] messages. */
  writeQuery: (projectId: number, conversationId: number, body: { content: string; unique_id: string | null }) =>
    post<AiMessageDto[]>(`/projects/${projectId}/ai/conversations/${conversationId}/query`, body),
  /** Run the (possibly edited) SQL; progress arrives as `ai_query_updated` events. */
  runQuery: (projectId: number, messageId: number, sql: string) =>
    post<AiMessageDto>(`/projects/${projectId}/ai/messages/${messageId}/run`, { sql }),
  /** Stream an answer from a finished query's result rows (they're sent to the model). */
  answerFromResults: (projectId: number, messageId: number, handlers: AskHandlers) =>
    streamPost(`/projects/${projectId}/ai/messages/${messageId}/answer`, undefined, handlers),

  document: (projectId: number, uniqueId: string, overwrite: boolean, conversationId: number | null) =>
    post<AiProposalDto>(`/projects/${projectId}/ai/document`, {
      unique_id: uniqueId, overwrite, conversation_id: conversationId,
    }),
  addTests: (projectId: number, uniqueId: string, conversationId: number | null) =>
    post<AiProposalDto>(`/projects/${projectId}/ai/tests`, { unique_id: uniqueId, conversation_id: conversationId }),
  proposals: (projectId: number, uniqueId?: string) =>
    get<AiProposalDto[]>(
      `/projects/${projectId}/ai/proposals${uniqueId ? `?unique_id=${encodeURIComponent(uniqueId)}` : ''}`,
    ),
  /** keys: items kept in the file (not rejected); accepted: those already accepted. */
  selectItems: (projectId: number, proposalId: number, keys: string[], accepted: string[]) =>
    put<AiProposalDto>(`/projects/${projectId}/ai/proposals/${proposalId}/selection`, { keys, accepted }),
  dismissProposal: (projectId: number, id: number) =>
    del<void>(`/projects/${projectId}/ai/proposals/${id}`),
  acceptFile: (projectId: number, proposalId: number, fileId: number) =>
    post<AiProposalDto>(`/projects/${projectId}/ai/proposals/${proposalId}/files/${fileId}/accept`),
  rejectFile: (projectId: number, proposalId: number, fileId: number) =>
    post<AiProposalDto>(`/projects/${projectId}/ai/proposals/${proposalId}/files/${fileId}/reject`),
};

export function aiErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) {
    if (typeof err.body === 'string') return err.body;
    if (err.status === 503) return 'AI features aren’t available in this build (the wickd Pro package is not installed).';
  }
  return err instanceof Error ? err.message : fallback;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}
