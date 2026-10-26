import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { currentDialog, resolveDialog, subscribeDialogs, type DialogRequest } from '../lib/dialogs';

const DEFAULT_TITLE: Record<DialogRequest['kind'], string> = {
  alert: 'Notice',
  confirm: 'Are you sure?',
  prompt: 'Enter a value',
};

function Dialog({ dialog }: { dialog: DialogRequest }) {
  const [value, setValue] = useState(dialog.defaultValue ?? '');
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isPrompt = dialog.kind === 'prompt';

  const ok = () => resolveDialog(isPrompt ? value : true);
  const cancel = () => resolveDialog(null);

  useEffect(() => {
    if (isPrompt) inputRef.current?.select();
    else okRef.current?.focus();
  }, [isPrompt]);

  // Capture phase, so Escape/Enter answer this dialog instead of closing a modal underneath
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); ok(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const okClass = dialog.danger
    ? 'bg-red-600 hover:bg-red-500 text-white'
    : 'bg-brand-600 hover:bg-brand-500 text-white';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60" onMouseDown={cancel}>
      <div
        role="alertdialog"
        aria-modal
        aria-labelledby="wickd-dialog-title"
        className="bg-surface-panel border border-gray-700 rounded-lg shadow-2xl w-[420px] max-w-[calc(100vw-32px)] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 id="wickd-dialog-title" className="text-sm font-semibold text-gray-200">
            {dialog.title ?? DEFAULT_TITLE[dialog.kind]}
          </h2>
        </div>
        <div className="px-4 py-4 flex flex-col gap-3">
          <p className="text-xs text-gray-300 whitespace-pre-wrap break-words">{dialog.message}</p>
          {isPrompt && (
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              className="bg-surface-elevated border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-800">
          {dialog.kind !== 'alert' && (
            <button
              onClick={cancel}
              className="px-3 py-1.5 text-xs rounded border border-gray-700 bg-surface-elevated text-gray-300 hover:bg-gray-700"
            >
              Cancel
            </button>
          )}
          <button ref={okRef} onClick={ok} className={`px-3 py-1.5 text-xs rounded font-medium ${okClass}`}>
            {dialog.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Renders the alert/confirm/prompt requested through lib/dialogs.ts. Mount once. */
export function DialogHost() {
  const dialog = useSyncExternalStore(subscribeDialogs, currentDialog);
  return dialog ? <Dialog key={dialog.id} dialog={dialog} /> : null;
}
