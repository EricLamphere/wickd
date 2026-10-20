import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { Database, Loader2, MessageCircle, Plus, Send, Square, Trash2 } from 'lucide-react';
import type { ModelNode } from '../../../../lib/api';
import {
  aiApi, aiErrorMessage, type AiConversationDto, type AiMessageDto, type AiProposalProgress, type AskHandlers,
  type AskMode, type AskResult,
} from '../../../../lib/aiApi';
import { ActionEntry } from './ActionEntry';
import { QueryEntry } from './QueryEntry';

interface AiChatProps {
  projectId: number;
  model: ModelNode | null;
  /** Live progress of quick actions that are still generating, by proposal id. */
  progress: Record<number, AiProposalProgress>;
  /** The open chat (shared with Quick actions so their results land in it). */
  conversations: AiConversationDto[];
  activeId: number | null;
  onSelect: (id: number | null) => void;
  ensureConversation: () => Promise<number>;
  /** Send a message on someone else's behalf (e.g. Explain failure); a new nonce sends again. */
  request: ChatRequest | null;
}

export interface ChatRequest {
  nonce: number;
  text: string;
  mode: AskMode;
}

interface Pending {
  /** null when nothing new was asked (e.g. answering from query results) */
  question: string | null;
  answer: string;
  /** what's being waited for before any text arrives */
  waiting: string;
  /** a streamed answer can be stopped; writing a query can't */
  stoppable: boolean;
}

/** Ask = answers from the project's code and docs; Query = Wicky writes SQL you run. */
type ChatMode = 'ask' | 'query';

const QUERY_SUGGESTIONS = ['How many rows are there, and how many per day recently?', 'Show the most common values of each category column'];

const NODE_SUGGESTIONS = ['What does this model do?', 'How is each column derived?', 'What would break if I changed it?'];
const PROJECT_SUGGESTIONS = ['Give me an overview of this project', 'Which models are the main marts?', 'Which models have no description?'];

function Bubble({ role, children }: { role: AiMessageDto['role']; children: React.ReactNode }) {
  // `action` entries open with what the user asked for, styled like their own message
  return role !== 'assistant' ? (
    <div className="self-end max-w-[90%] px-2.5 py-1.5 rounded-lg bg-brand-900/50 text-gray-200 whitespace-pre-wrap break-words">
      {children}
    </div>
  ) : (
    <div className="prose-readme text-xs text-gray-300 break-words">{children}</div>
  );
}

/** Ask mode: chat about the project, with the selected node's context sent along. */
export function AiChat({
  projectId, model, progress, conversations, activeId, onSelect, ensureConversation, request,
}: AiChatProps) {
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [chatMode, setChatMode] = useState<ChatMode>('ask');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversation = useQuery({
    queryKey: ['ai-conversation', projectId, activeId],
    queryFn: () => aiApi.conversation(projectId, activeId!),
    enabled: activeId !== null,
  });
  const messages = activeId === null ? [] : conversation.data?.messages ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending?.answer, progress]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** Stream a reply into the chat, then reload the conversation (which now holds it). */
  const stream = async (
    question: string | null,
    start: (conversationId: number, handlers: AskHandlers) => Promise<AskResult>,
  ) => {
    setError(null);
    setPending({ question, answer: '', waiting: 'Thinking…', stoppable: true });
    const controller = new AbortController();
    abortRef.current = controller;
    let id: number | null = null;
    try {
      id = await ensureConversation();
      const result = await start(id, {
        signal: controller.signal,
        onDelta: (delta) => setPending((p) => (p ? { ...p, answer: p.answer + delta } : p)),
      });
      if (!result.ok) setError(result.error);
    } catch (err) {
      if (!controller.signal.aborted) setError(aiErrorMessage(err));
    } finally {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['ai-conversation', projectId, ...(id === null ? [] : [id])] }),
        qc.invalidateQueries({ queryKey: ['ai-conversations', projectId] }),
      ]);
      abortRef.current = null;
      setPending(null);
    }
  };

  /** Query mode: Wicky writes the SQL; it shows up in the chat for you to review and run. */
  const writeQuery = async (question: string) => {
    setError(null);
    setPending({ question, answer: '', waiting: 'Writing a query…', stoppable: false });
    try {
      const id = await ensureConversation();
      await aiApi.writeQuery(projectId, id, { content: question, unique_id: model?.unique_id ?? null });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['ai-conversation', projectId, id] }),
        qc.invalidateQueries({ queryKey: ['ai-conversations', projectId] }),
      ]);
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setPending(null);
    }
  };

  const send = async (text: string, mode: AskMode = 'ask') => {
    const question = text.trim();
    if (!question || pending) return;
    setInput('');
    if (chatMode === 'query' && mode === 'ask') return writeQuery(question);
    return stream(question, (id, handlers) => aiApi.ask(
      projectId, id, { content: question, unique_id: model?.unique_id ?? null, mode }, handlers,
    ));
  };

  const answerFromResults = (messageId: number) => {
    if (pending) return;
    void stream(null, (_id, handlers) => aiApi.answerFromResults(projectId, messageId, handlers));
  };

  // Requests from Quick actions (e.g. Explain failure) — each new nonce sends once.
  const sentNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!request || request.nonce === sentNonce.current) return;
    sentNonce.current = request.nonce;
    void send(request.text, request.mode);
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  const newChat = async () => {
    abortRef.current?.abort();
    const created = await aiApi.createConversation(projectId);
    onSelect(created.id);
    qc.invalidateQueries({ queryKey: ['ai-conversations', projectId] });
  };

  const deleteChat = async () => {
    if (activeId === null) return;
    await aiApi.deleteConversation(projectId, activeId);
    onSelect(null);
    qc.invalidateQueries({ queryKey: ['ai-conversations', projectId] });
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 text-xs">
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-800 shrink-0">
        <select
          value={activeId ?? ''}
          onChange={(e) => onSelect(Number(e.target.value))}
          className="flex-1 min-w-0 bg-transparent text-gray-400 truncate focus:outline-none"
        >
          {activeId === null && <option value="">New chat</option>}
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>{c.title || 'New chat'}</option>
          ))}
        </select>
        <button onClick={newChat} className="p-1 text-gray-500 hover:text-gray-300" title="New chat"><Plus size={13} /></button>
        <button onClick={deleteChat} disabled={activeId === null} className="p-1 text-gray-500 hover:text-red-400 disabled:opacity-30" title="Delete chat">
          <Trash2 size={13} />
        </button>
      </div>

      <div ref={scrollRef} className="flex flex-col flex-1 gap-3 px-3 py-3 overflow-auto">
        {messages.length === 0 && !pending && (
          <div className="flex flex-col gap-1.5 text-gray-500">
            {chatMode === 'ask'
              ? <p>Ask Wicky about {model ? <code>{model.name}</code> : 'this project'}. Answers come from the project&rsquo;s SQL and docs, not the data.</p>
              : <p>Ask a question about your data. Wicky writes a read-only query{model ? <> around <code>{model.name}</code></> : ''} for you to review and run.</p>}
            {(chatMode === 'query' ? QUERY_SUGGESTIONS : model ? NODE_SUGGESTIONS : PROJECT_SUGGESTIONS).map((s) => (
              <button key={s} onClick={() => send(s)} className="self-start px-2 py-1 rounded border border-gray-800 text-gray-400 hover:border-gray-600 hover:text-gray-200">
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => m.role === 'action' ? (
          <div key={m.id} className="flex flex-col gap-2">
            <Bubble role="user">{m.content}</Bubble>
            {m.proposal && (
              <ActionEntry projectId={projectId} proposal={m.proposal} progress={progress[m.proposal.id]} />
            )}
          </div>
        ) : m.role === 'query' && m.payload ? (
          <QueryEntry
            key={m.id}
            projectId={projectId}
            message={m}
            busy={pending !== null}
            onAnswer={() => answerFromResults(m.id)}
          />
        ) : (
          <Bubble key={m.id} role={m.role}>
            {m.role === 'assistant' ? <ReactMarkdown>{m.content}</ReactMarkdown> : m.content}
          </Bubble>
        ))}
        {pending && (
          <>
            {pending.question !== null && <Bubble role="user">{pending.question}</Bubble>}
            {pending.answer
              ? <Bubble role="assistant"><ReactMarkdown>{pending.answer}</ReactMarkdown></Bubble>
              : <span className="flex items-center gap-2 text-gray-500"><Loader2 size={12} className="animate-spin" /> {pending.waiting}</span>}
          </>
        )}
        {error && <p className="text-red-400 break-words">{error}</p>}
      </div>

      <div className="flex flex-col gap-1 px-3 py-2 border-t border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-gray-800 overflow-hidden" role="tablist">
            {([['ask', 'Ask', MessageCircle], ['query', 'Query data', Database]] as const).map(([value, label, Icon]) => (
              <button
                key={value}
                onClick={() => setChatMode(value)}
                title={value === 'ask'
                  ? 'Answers from the project\u2019s SQL and docs'
                  : 'Wicky writes a read-only SQL query for you to review and run against the warehouse'}
                className={`flex items-center gap-1 px-2 py-0.5 text-[11px] ${
                  chatMode === value ? 'bg-surface-elevated text-gray-200' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
          </div>
          {model && <span className="ml-auto text-[10px] text-gray-600 truncate">Context: <code>{model.name}</code></span>}
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
            }}
            rows={2}
            placeholder={chatMode === 'query' ? 'Ask a question about your data…' : 'Ask Wicky…'}
            className="flex-1 resize-none px-2 py-1.5 rounded bg-surface-elevated border border-gray-700 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500"
          />
          {pending?.stoppable ? (
            <button
              onClick={() => abortRef.current?.abort()}
              className="flex items-center justify-center w-7 h-7 mb-0.5 rounded-full bg-gray-700 text-gray-100 hover:bg-gray-600"
              title="Stop generating"
            >
              <Square size={10} fill="currentColor" />
            </button>
          ) : pending ? (
            <span className="p-2 text-brand-300" title={pending.waiting}>
              <Loader2 size={14} className="animate-spin" />
            </span>
          ) : (
            <button onClick={() => send(input)} disabled={!input.trim()} className="p-2 rounded text-brand-300 hover:text-brand-200 disabled:opacity-30" title="Send (Enter)">
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
