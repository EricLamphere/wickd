// A widget's SQL: every query it ran (current, previous, total, trend …), copyable.
import { useEffect } from 'react';
import { Copy, X } from 'lucide-react';
import type { WidgetQueryDto } from '../../../../../lib/dashboardsApi';

const ROLE_LABELS: Record<string, string> = {
  current: 'Current period', current_previous: 'Previous period', total: 'Total', total_previous: 'Total, previous period',
  trend: 'Trend', trend_previous: 'Trend, previous period',
};

export function SqlDialog({ queries, onClose }: { queries: Record<string, WidgetQueryDto>; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div role="dialog" aria-label="Widget SQL" onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-full max-w-3xl max-h-[80vh] mx-4 bg-surface-panel border border-gray-700 rounded-lg shadow-2xl">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-100">SQL</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          {Object.entries(queries).map(([role, q]) => (
            <section key={role} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{ROLE_LABELS[role] ?? role}</h3>
                {q.sql && (
                  <button onClick={() => navigator.clipboard?.writeText(q.sql ?? '')} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200">
                    <Copy className="w-3 h-3" />Copy
                  </button>
                )}
              </div>
              <pre className="p-2 text-[11px] font-mono text-gray-300 whitespace-pre-wrap bg-surface-app rounded border border-gray-800">
                {q.sql ?? q.error ?? 'Not explained'}
              </pre>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
