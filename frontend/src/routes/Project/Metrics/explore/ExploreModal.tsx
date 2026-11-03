// The query view as a modal over the metric page (or the index) it was opened from: most of the
// window, closed with its ✕, a click outside it, or Escape — when nothing inside it (a period
// picker, a dialog) is open on top, so Escape closes that first. A failure inside shows its error
// here (ErrorBoundary) rather than blanking the app.
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { ErrorBoundary } from '../../../../components/ErrorBoundary';

export function ExploreModal({ title, resetKey, onClose, children }: {
  title: string;
  /** the query shown: a new one clears an error */
  resetKey: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // only when this is the topmost dialog (popovers and dialogs inside it come later in the document)
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      // an open ⋯ menu closes first
      if (panel.current?.querySelector('[role="menu"]')) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 bg-black/60" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title}
        className="flex flex-col w-full h-full max-w-[1800px] rounded-lg border border-gray-700 bg-surface-app shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 bg-surface-panel shrink-0">
          <h2 className="flex-1 min-w-0 text-base font-semibold text-gray-100 truncate" title={title}>{title}</h2>
          <button onClick={onClose} aria-label="Close" title="Close (Esc)" className="p-1 rounded text-gray-400 hover:bg-gray-800 hover:text-gray-100">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <ErrorBoundary name="Investigate" resetKey={resetKey} fallback={(error) => (
            <div className="flex flex-col items-center justify-center gap-2 h-full p-8 text-center">
              <p className="text-sm text-gray-200">Something went wrong drawing this view.</p>
              <p className="max-w-xl text-xs text-red-300 break-words">{error.message}</p>
              <button onClick={onClose} className="mt-2 px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">Close</button>
            </div>
          )}>
            {children}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
