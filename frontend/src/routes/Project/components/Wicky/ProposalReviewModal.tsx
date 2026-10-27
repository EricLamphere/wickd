import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { Check, CheckCheck, ChevronRight, Loader2, X } from 'lucide-react';
import { useTheme } from '../../../../lib/useTheme';
import { aiApi, aiErrorMessage, type AiProposalDto, type ManualReviewItem } from '../../../../lib/aiApi';
import { ChangeList, type ItemState } from './ChangeList';
import { InlineCode } from './InlineCode';
import { FILE_STATUS_STYLES, OpBadge, ProposalFileList } from './ProposalFileList';
import { diffTexts, fileForItem, fileTitle, languageFor, showsFileList } from './proposalFiles';
import { findItemLine, itemsInFile, proposalItems, selectedKeys, type ProposalItem } from './proposalItems';

interface ProposalReviewModalProps {
  projectId: number;
  proposal: AiProposalDto;
  onClose: () => void;
}

type DiffEditorInstance = Parameters<DiffOnMount>[0];

const REVEAL_DELAY_MS = 50;
const SECONDARY = 'bg-surface-elevated border border-gray-700 text-gray-300 hover:bg-gray-700';
const FOOTER_BUTTON = 'flex items-center gap-1 px-3 py-1.5 text-xs rounded disabled:opacity-40';

/**
 * Review AI-proposed changes. Proposals made of separate items (tests,
 * descriptions) list them on the left: click one to jump to it in the diff,
 * ✓ / ✗ to decide it — rejecting rebuilds the file without it. Once every
 * item is decided the file is applied (or rejected, if nothing was kept).
 * Proposals spanning several files (lineage propagation, refactors) list their
 * files on the left — with New / Deleted / Renamed badges — and each file can be
 * decided on its own (Accept file / Reject file). Every proposal always has
 * Reject all and Accept all, which decide the whole proposal at once (POST
 * .../reject, .../accept; items rejected in review stay out). Refactors also list
 * the edits they didn't make under "Needs manual review".
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
  const refactor = proposal.kind === 'refactor';
  const manual = proposal.result.manual ?? [];
  const kept = selectedKeys(proposal);
  const active = files.find((f) => f.id === activeId) ?? files[0];
  const allItems = proposalItems(proposal);
  const multiFile = files.length > 1;
  // a multi-file proposal only has per-item review when its items name their file
  const items = !multiFile || allItems.some((i) => i.file) ? itemsInFile(allItems, active?.path) : [];
  const keptInFile = items.filter((i) => kept.has(i.key)).length;
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

  /** Open the manual item's file and highlight its line (on the original side: lines refer to it). */
  const revealManual = (item: ManualReviewItem) => {
    const file = fileForItem(files, item);
    if (!file) return;
    setActiveId(file.id);
    window.setTimeout(() => {
      const editor = editorRef.current?.getOriginalEditor();
      if (!editor) return;
      highlight.current?.clear();
      editor.revealLineInCenter(item.line);
      highlight.current = editor.createDecorationsCollection([{
        range: { startLineNumber: item.line, startColumn: 1, endLineNumber: item.line, endColumn: 1 },
        options: { isWholeLine: true, className: 'wicky-focus-line' },
      }]);
    }, REVEAL_DELAY_MS);
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
      multiFile ? active?.id : undefined,
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
      await decideFile(items.some((i) => keep.has(i.key)), updated);
    }
  });

  /** Multi-file proposals: decide just the open file (with what's kept of its items). */
  const acceptThisFile = () => run(async () => {
    const current = items.length > 0 ? await save(kept, kept) : proposal;
    await decideFile(true, current);
  });

  const rejectThisFile = () => run(() => decideFile(false));

  /** The whole proposal at once: every pending file (items rejected in review stay out). */
  const decideEverything = (accept: boolean) => run(async () => {
    const updated = accept
      ? await aiApi.acceptAll(projectId, proposal.id)
      : await aiApi.rejectAll(projectId, proposal.id);
    setProposal(updated);
    qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
    qc.invalidateQueries({ queryKey: ['ai-conversation', projectId] });
    onClose();
  });

  if (!active) return null;
  const pending = active.status === 'pending';
  const someRejected = items.some((i) => stateOf(i.key) === 'rejected');
  const pendingFiles = files.filter((f) => f.status === 'pending').length;
  // single-file proposals made of items: nothing left to accept once every item is rejected
  const nothingKept = !multiFile && items.length > 0 && keptInFile === 0;
  const diff = diffTexts(active);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex flex-col w-full max-w-6xl h-full max-h-[85vh] bg-surface-panel border border-gray-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-gray-200 truncate"><InlineCode text={proposal.title} /></h2>
            <p className="text-[11px] text-gray-500">
              {refactor
                ? 'Review each file. Accept all writes them all at once, then runs dbt parse; you can undo it afterwards.'
                : items.length > 0
                  ? 'Click a change to find it in the diff; accept or reject each one. Nothing is written until every change is decided.'
                  : 'Review each change. Nothing is written until you accept it.'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-300" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {showsFileList(proposal) && (
            <ProposalFileList
              files={files}
              activeId={active.id}
              onSelect={setActiveId}
              manual={manual}
              onReveal={revealManual}
            />
          )}
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
          <div className="flex flex-col flex-1 min-w-0">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 text-xs shrink-0">
              <span className="font-mono text-gray-400 truncate">{fileTitle(active)}</span>
              <OpBadge file={active} />
              {!pending && <span className={`ml-auto ${FILE_STATUS_STYLES[active.status]}`}>{active.status}</span>}
            </div>
            <div className="flex-1 min-h-0">
              <DiffEditor
                original={diff.original}
                modified={diff.modified}
                language={languageFor(active.new_path ?? active.path)}
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
          {multiFile && (
            <>
              <button onClick={rejectThisFile} disabled={busy || !pending} className={`${FOOTER_BUTTON} ${SECONDARY}`}>
                <X size={12} /> Reject file
              </button>
              <button
                onClick={acceptThisFile}
                disabled={busy || !pending || (items.length > 0 && keptInFile === 0)}
                className={`${FOOTER_BUTTON} ${SECONDARY}`}
              >
                <Check size={12} /> {someRejected ? 'Accept the rest of this file' : 'Accept file'}
              </button>
            </>
          )}
          <button
            onClick={() => decideEverything(false)}
            disabled={busy || pendingFiles === 0}
            title="Reject every change; nothing is written"
            className={`${FOOTER_BUTTON} ${SECONDARY}`}
          >
            <X size={12} /> Reject all
          </button>
          <button
            onClick={() => decideEverything(true)}
            disabled={busy || pendingFiles === 0 || nothingKept}
            title={refactor
              ? 'Write every file at once (or none, if any changed since this was made), then check with dbt parse'
              : 'Write every remaining change (anything you rejected stays out); nothing is written if a file changed since this was made'}
            className={`${FOOTER_BUTTON} bg-brand-600 text-white hover:bg-brand-500`}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />} Accept all
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
