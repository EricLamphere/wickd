import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { Check, ChevronRight, FileText, Loader2, X } from 'lucide-react';
import { useTheme } from '../../../../lib/useTheme';
import { aiApi, aiErrorMessage, type AiProposalDto, type AiProposalFileDto } from '../../../../lib/aiApi';
import { ChangeList, type ItemState } from './ChangeList';
import { findItemLine, proposalItems, selectedKeys, type ProposalItem } from './proposalItems';

interface ProposalReviewModalProps {
  projectId: number;
  proposal: AiProposalDto;
  onClose: () => void;
}

type DiffEditorInstance = Parameters<DiffOnMount>[0];

function languageFor(path: string): string {
  if (path.endsWith('.sql')) return 'sql';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  return 'plaintext';
}

const FILE_STATUS_STYLES: Record<AiProposalFileDto['status'], string> = {
  pending: 'text-gray-400',
  accepted: 'text-emerald-400',
  rejected: 'text-gray-600 line-through',
};

/**
 * Review AI-proposed changes. Proposals made of separate items (tests,
 * descriptions) list them on the left: click one to jump to it in the diff,
 * ✓ / ✗ to decide it — rejecting rebuilds the file without it. Once every
 * item is decided the file is applied (or rejected, if nothing was kept).
 * Accept all / Reject all decide the whole file at once.
 */
export function ProposalReviewModal({ projectId, proposal: initial, onClose }: ProposalReviewModalProps) {
  const qc = useQueryClient();
  const theme = useTheme();
  const [proposal, setProposal] = useState(initial);
  const [activeId, setActiveId] = useState(() => (initial.files.find((f) => f.status === 'pending') ?? initial.files[0])?.id);
  const [focused, setFocused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<DiffEditorInstance | null>(null);
  const highlight = useRef<{ clear: () => void } | null>(null);

  const files = proposal.files;
  const active = files.find((f) => f.id === activeId) ?? files[0];
  const items = files.length === 1 ? proposalItems(proposal) : [];
  const kept = selectedKeys(proposal);
  const accepted = new Set(proposal.result.accepted ?? []);
  const stateOf = (key: string): ItemState => (!kept.has(key) ? 'rejected' : accepted.has(key) ? 'accepted' : 'pending');
  const nextPendingFile = useMemo(
    () => files.find((f) => f.status === 'pending' && f.id !== active?.id),
    [files, active?.id],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reveal = useCallback((item: ProposalItem | undefined) => {
    const editor = editorRef.current?.getModifiedEditor();
    highlight.current?.clear();
    if (!editor || !item || !active) return;
    const line = findItemLine(active.proposed_text, proposal, item);
    if (line === null) return;
    editor.revealLineInCenter(line);
    highlight.current = editor.createDecorationsCollection([{
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { isWholeLine: true, className: 'wicky-focus-line' },
    }]);
  }, [active, proposal]);

  // keep the highlight on the focused change when the file is rebuilt
  useEffect(() => {
    reveal(items.find((i) => i.key === focused));
  }, [active?.proposed_text]); // eslint-disable-line react-hooks/exhaustive-deps

  const focus = (item: ProposalItem) => {
    setFocused(item.key);
    reveal(item);
  };

  const decideFile = async (accept: boolean, current: AiProposalDto = proposal) => {
    const file = current.files.find((f) => f.id === active?.id);
    if (!file) return;
    const updated = accept
      ? await aiApi.acceptFile(projectId, current.id, file.id)
      : await aiApi.rejectFile(projectId, current.id, file.id);
    setProposal(updated);
    qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
    qc.invalidateQueries({ queryKey: ['ai-conversation', projectId] });
    const next = updated.files.find((f) => f.status === 'pending');
    if (next) setActiveId(next.id);
    else onClose();
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (keep: Set<string>, done: Set<string>) =>
    aiApi.selectItems(
      projectId, proposal.id,
      items.map((i) => i.key).filter((k) => keep.has(k)),
      items.map((i) => i.key).filter((k) => keep.has(k) && done.has(k)),
    );

  const decideItem = (key: string, decision: 'accept' | 'reject' | 'undo') => run(async () => {
    const keep = new Set(kept);
    const done = new Set(accepted);
    if (decision === 'reject') keep.delete(key);
    if (decision === 'accept') done.add(key);
    if (decision === 'undo') { keep.add(key); done.delete(key); }
    const updated = await save(keep, done);
    setProposal(updated);
    // every change decided → apply what was kept (or reject the file if nothing was)
    if (items.every((i) => !keep.has(i.key) || done.has(i.key))) {
      await decideFile(keep.size > 0, updated);
    }
  });

  const acceptAll = () => run(async () => {
    const current = items.length > 0 ? await save(kept, kept) : proposal;
    await decideFile(true, current);
  });

  const rejectAll = () => run(() => decideFile(false));

  if (!active) return null;
  const pending = active.status === 'pending';
  const someRejected = items.some((i) => stateOf(i.key) === 'rejected');

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex flex-col w-full max-w-6xl h-full max-h-[85vh] bg-surface-panel border border-gray-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-gray-200 truncate">{proposal.title}</h2>
            <p className="text-[11px] text-gray-500">
              {items.length > 0
                ? 'Click a change to find it in the diff; accept or reject each one. Nothing is written until every change is decided.'
                : 'Review each change. Nothing is written until you accept it.'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-300" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {items.length > 0 && pending && (
            <ChangeList
              items={items}
              stateOf={stateOf}
              focused={focused}
              disabled={busy}
              onFocus={focus}
              onDecide={decideItem}
            />
          )}
          {files.length > 1 && (
            <div className="w-56 shrink-0 border-r border-gray-800 overflow-auto py-1">
              {files.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setActiveId(f.id)}
                  className={`flex items-center gap-1.5 w-full px-3 py-1.5 text-left text-xs font-mono ${
                    f.id === active.id ? 'bg-surface-elevated' : 'hover:bg-surface-elevated/60'
                  } ${FILE_STATUS_STYLES[f.status]}`}
                >
                  <FileText size={12} className="shrink-0" />
                  <span className="truncate">{f.path}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-col flex-1 min-w-0">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 text-xs shrink-0">
              <span className="font-mono text-gray-400 truncate">{active.path}</span>
              {active.original_text === null && (
                <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/50 text-[10px] uppercase tracking-wide text-emerald-400">
                  new file
                </span>
              )}
              {!pending && <span className={`ml-auto ${FILE_STATUS_STYLES[active.status]}`}>{active.status}</span>}
            </div>
            <div className="flex-1 min-h-0">
              <DiffEditor
                original={active.original_text ?? ''}
                modified={active.proposed_text}
                language={languageFor(active.path)}
                theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
                onMount={(editor) => { editorRef.current = editor; }}
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  fontSize: 13,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                }}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-gray-800 shrink-0">
          {error && <span className="text-xs text-red-400 truncate" title={error}>{error}</span>}
          <span className="ml-auto" />
          {nextPendingFile && (
            <button
              onClick={() => setActiveId(nextPendingFile.id)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded text-gray-400 hover:text-gray-200"
            >
              Next file <ChevronRight size={12} />
            </button>
          )}
          <button
            onClick={rejectAll}
            disabled={busy || !pending}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-surface-elevated border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
          >
            <X size={12} /> {items.length > 0 ? 'Reject all' : 'Reject'}
          </button>
          <button
            onClick={acceptAll}
            disabled={busy || !pending || (items.length > 0 && kept.size === 0)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {items.length === 0 ? 'Accept' : someRejected ? 'Accept the rest' : 'Accept all'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
