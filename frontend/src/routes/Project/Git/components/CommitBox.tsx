import { useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../../../../lib/api';

/** The message box starts one line tall and grows with its content up to this height. */
const MAX_MESSAGE_HEIGHT = 160;

interface Props {
  projectId: number;
  stagedCount: number;
  syncOutput: string[];
}

/** VS Code-style commit input: an auto-growing message box above a slim Commit button. */
export function CommitBox({ projectId, stagedCount, syncOutput }: Props) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [commitError, setCommitError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_MESSAGE_HEIGHT)}px`;
  }, [message]);

  const commitMutation = useMutation({
    mutationFn: () => api.git.commit(projectId, message.trim()),
    onSuccess: () => {
      setMessage('');
      setCommitError('');
      qc.invalidateQueries({ queryKey: ['git', 'status', projectId] });
    },
    onError: (err: Error) => {
      setCommitError(err.message);
    },
  });

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (message.trim() && stagedCount > 0) commitMutation.mutate();
    }
  }

  const canCommit = message.trim().length > 0 && stagedCount > 0 && !commitMutation.isPending;

  return (
    <div className="flex flex-col gap-1.5 px-2 pb-2 shrink-0">
      <textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={stagedCount > 0 ? 'Message (⌘↵ to commit)' : 'Stage changes to commit'}
        rows={1}
        className="w-full bg-surface-elevated border border-zinc-700 rounded px-2 py-1 text-xs text-gray-200
          placeholder-zinc-600 focus:outline-none focus:border-brand-500 resize-none overflow-y-auto"
      />

      {commitError && (
        <p className="text-xs text-red-400 truncate" title={commitError}>
          {commitError}
        </p>
      )}

      <button
        onClick={() => commitMutation.mutate()}
        disabled={!canCommit}
        className="w-full py-1 rounded text-xs font-medium
          bg-brand-600 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed
          text-white transition-colors"
      >
        {commitMutation.isPending
          ? 'Committing…'
          : stagedCount > 0
          ? `Commit ${stagedCount} file${stagedCount !== 1 ? 's' : ''}`
          : 'Commit'}
      </button>

      {/* SSE push/pull output */}
      {syncOutput.length > 0 && (
        <div className="bg-surface-elevated rounded p-2 text-xs font-mono text-gray-300 max-h-24 overflow-y-auto">
          {syncOutput.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
