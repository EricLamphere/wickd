import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Loader2, Plus, Send, Square, Trash2 } from 'lucide-react';
import { aiErrorMessage } from '../../lib/aiApi';
import { api } from '../../lib/api';
import { alertDialog, alertError } from '../../lib/dialogs';
import { workspaceApi } from '../../lib/workspaceApi';
import { Bubble } from '../Project/components/Wicky/AiChat';
import { WickyGate } from '../Project/components/Wicky/WickyContent';
import { useWickyPaneLayout, WickyPaneFrame } from '../Project/components/Wicky/WickyPaneFrame';
import { nodeRefUrl, parseNodeRef, wickyScopeLabel, type NodeRef } from './docsJoin';
import { useWorkspaceDocs } from './useWorkspaceDocs';

const SUGGESTIONS = [
  'Give me an overview of these projects',
  'Which projects have an orders model?',
  'Where is customer_id used?',
];

const CONVERSATIONS_KEY = ['workspace-conversations'] as const;

interface Pending {
  question: string;
  answer: string;
}

/** Finds a node Wicky named and opens its docs. */
function useOpenNodeRef(selection: number[]) {
  const navigate = useNavigate();
  return async (ref: NodeRef) => {
    try {
      const { hits } = await api.projects.searchNodes(ref.node);
      const hit = hits.find((h) => h.project_name === ref.project && h.name.toLowerCase() === ref.node.toLowerCase());
      if (hit) navigate(nodeRefUrl(hit, selection));
      else await alertDialog(`Couldn't find ${ref.node} in ${ref.project}. It may have been renamed since it was last compiled.`);
    } catch (err) {
      alertError(err);
    }
  };
}

/** Home page chat: read-only questions across projects. */
function WorkspaceChat({ projectNames, selection }: { projectNames: string[]; selection: number[] }) {
  const qc = useQueryClient();
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openNodeRef = useOpenNodeRef(selection);

  const conversations = useQuery({ queryKey: CONVERSATIONS_KEY, queryFn: workspaceApi.conversations });
  const activeId = chosenId ?? conversations.data?.[0]?.id ?? null;
  const conversation = useQuery({
    queryKey: ['workspace-conversation', activeId],
    queryFn: () => workspaceApi.conversation(activeId!),
    enabled: activeId !== null,
  });
  const messages = activeId === null ? [] : conversation.data?.messages ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, pending?.answer]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || pending) return;
    setInput('');
    setError(null);
    setPending({ question, answer: '' });
    const controller = new AbortController();
    abortRef.current = controller;
    let id = activeId;
    try {
      if (id === null) {
        id = (await workspaceApi.createConversation()).id;
        setChosenId(id);
      }
      const result = await workspaceApi.ask(id, question, {
        signal: controller.signal,
        onDelta: (delta) => setPending((p) => (p ? { ...p, answer: p.answer + delta } : p)),
      });
      if (!result.ok) setError(result.error);
    } catch (err) {
      if (!controller.signal.aborted) setError(aiErrorMessage(err));
    } finally {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['workspace-conversation', id] }),
        qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY }),
      ]);
      abortRef.current = null;
      setPending(null);
    }
  };

  const newChat = async () => {
    abortRef.current?.abort();
    try {
      const created = await workspaceApi.createConversation();
      setChosenId(created.id);
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    } catch (err) {
      alertError(err);
    }
  };

  const deleteChat = async () => {
    if (activeId === null) return;
    try {
      await workspaceApi.deleteConversation(activeId);
      setChosenId(null);
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    } catch (err) {
      alertError(err);
    }
  };

  const markdown = useMemo<Components>(() => ({
    code({ children, className }) {
      const ref = !className && typeof children === 'string' ? parseNodeRef(children, projectNames) : null;
      if (!ref) return <code className={className}>{children}</code>;
      return (
        <button
          onClick={() => void openNodeRef(ref)}
          title="Open docs"
          className="font-mono text-brand-300 underline decoration-dotted hover:text-brand-200"
        >
          {children}
        </button>
      );
    },
  }), [projectNames, selection]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-800 shrink-0">
        <select
          value={activeId ?? ''}
          onChange={(e) => setChosenId(Number(e.target.value))}
          className="flex-1 min-w-0 text-gray-400 truncate bg-transparent focus:outline-none"
        >
          {activeId === null && <option value="">New chat</option>}
          {(conversations.data ?? []).map((c) => (
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
            <p>Ask Wicky about your projects. Answers come from their names, descriptions, columns and lineage, not the data. To query data or change code, open a project.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} className="self-start px-2 py-1 text-gray-400 border border-gray-800 rounded hover:border-gray-600 hover:text-gray-200">
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role}>
            {m.role === 'assistant' ? <ReactMarkdown components={markdown}>{m.content}</ReactMarkdown> : m.content}
          </Bubble>
        ))}
        {pending && (
          <>
            <Bubble role="user">{pending.question}</Bubble>
            {pending.answer
              ? <Bubble role="assistant"><ReactMarkdown components={markdown}>{pending.answer}</ReactMarkdown></Bubble>
              : <span className="flex items-center gap-2 text-gray-500"><Loader2 size={12} className="animate-spin" /> Thinking…</span>}
          </>
        )}
        {error && <p className="text-red-400 break-words">{error}</p>}
      </div>

      <div className="flex items-end gap-1.5 px-3 py-2 border-t border-gray-800 shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); }
          }}
          rows={2}
          placeholder="Ask Wicky about your projects…"
          className="flex-1 px-2 py-1.5 text-gray-200 placeholder-gray-600 border border-gray-700 rounded resize-none bg-surface-elevated focus:outline-none focus:border-brand-500"
        />
        {pending ? (
          <button
            onClick={() => abortRef.current?.abort()}
            className="flex items-center justify-center w-7 h-7 mb-0.5 text-gray-100 bg-gray-700 rounded-full hover:bg-gray-600"
            title="Stop generating"
          >
            <Square size={10} fill="currentColor" />
          </button>
        ) : (
          <button onClick={() => send(input)} disabled={!input.trim()} className="p-2 rounded text-brand-300 hover:text-brand-200 disabled:opacity-30" title="Send (Enter)">
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Wicky on the home page (wickd Pro): the same panel as in a project, across projects. */
export function WorkspaceWickyPane() {
  const layout = useWickyPaneLayout();
  const { projects, selection } = useWorkspaceDocs();
  const projectNames = useMemo(() => projects.map((p) => p.name), [projects]);

  return (
    <WickyPaneFrame layout={layout} scope={wickyScopeLabel(selection.length)}>
      <WickyGate>
        <WorkspaceChat projectNames={projectNames} selection={selection} />
      </WickyGate>
    </WickyPaneFrame>
  );
}
