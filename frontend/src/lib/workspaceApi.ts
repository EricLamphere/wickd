// Typed helpers for the home page's workspace routes: combined docs and Wicky across
// projects. Kept out of api.ts, which is already past the file-size limit.
import { del, get, post, put } from './api';
import { streamPost, type AskHandlers, type AskResult } from './aiApi';

export type WorkspaceDocsState = 'idle' | 'queued' | 'generating' | 'done' | 'error';

export interface WorkspaceDocsProject {
  id: number;
  name: string;
  platform: string;
  generated_at: string | null;
  state: WorkspaceDocsState;
  error: string | null;
}

export interface WorkspaceDocs {
  selection: number[];
  projects: WorkspaceDocsProject[];
}

/** `workspace_docs` on the global stream. */
export interface WorkspaceDocsEvent {
  project_id: number;
  state: WorkspaceDocsState;
  error: string | null;
}

export interface WorkspaceConversation {
  id: number;
  title: string;
  updated_at: string;
}

export interface WorkspaceMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

export interface WorkspaceConversationDetail extends WorkspaceConversation {
  messages: WorkspaceMessage[];
}

const AI = '/workspace/ai/conversations';

export const workspaceApi = {
  docs: () => get<WorkspaceDocs>('/workspace/docs'),
  setSelection: (projectIds: number[]) =>
    put<{ project_ids: number[] }>('/workspace/docs/selection', { project_ids: projectIds }),
  generateDocs: (projectIds: number[]) =>
    post<{ queued: number[] }>('/workspace/docs/generate', { project_ids: projectIds }),

  conversations: () => get<WorkspaceConversation[]>(AI),
  createConversation: () => post<WorkspaceConversationDetail>(AI),
  conversation: (id: number) => get<WorkspaceConversationDetail>(`${AI}/${id}`),
  deleteConversation: (id: number) => del<void>(`${AI}/${id}`),
  ask: (id: number, content: string, handlers: AskHandlers): Promise<AskResult> =>
    streamPost(`${AI}/${id}/messages`, { content }, handlers),
};
