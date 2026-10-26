import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { api, type ModelTimingDto } from '../../../lib/api';
import { DataTable } from '../../../components/DataTable';
import { OPEN_IN_FILES_HOVER_CLS, OPEN_IN_FILES_TITLE } from '../lib/openInFiles';
import type { FailedRowsCache, FileNav } from './shared';

const _failedRowsInflight = new Set<string>();

interface FailedTestRowProps {
  projectId: number;
  node: ModelTimingDto;
  failedRowsCache: FailedRowsCache;
  onFailedRowsCached: (uid: string, data: { columns: string[]; rows: unknown[][] }) => void;
  fileNav: FileNav;
}

export function FailedTestRow({ projectId, node, failedRowsCache, onFailedRowsCached, fileNav }: FailedTestRowProps) {
  const [open, setOpen] = useState(false);
  const canOpen = fileNav.canOpen(node.unique_id);
  const key = `${projectId}:${node.unique_id}`;
  const cached = failedRowsCache.get(node.unique_id) ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRows = async () => {
    if (_failedRowsInflight.has(key)) return;
    _failedRowsInflight.add(key);
    setLoading(true);
    setError(null);
    try {
      const result = await api.models.show(projectId, node.unique_id, 100);
      onFailedRowsCached(node.unique_id, result);
    } catch (e) {
      setError(String(e));
    } finally {
      _failedRowsInflight.delete(key);
      setLoading(false);
    }
  };

  function handleToggle(e: React.MouseEvent) {
    if (fileNav.handleClick(e, node.unique_id)) return;
    const next = !open;
    setOpen(next);
    if (next && !cached && !_failedRowsInflight.has(key)) {
      fetchRows();
    }
  }

  return (
    <div className="border-b border-gray-800/60 last:border-0">
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-elevated transition-colors"
        onClick={handleToggle}
      >
        <svg
          className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        <svg className="w-3.5 h-3.5 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <span className="flex-1 min-w-0 truncate">
          <span
            title={canOpen ? OPEN_IN_FILES_TITLE : undefined}
            className={`font-mono text-xs text-gray-300 ${canOpen ? OPEN_IN_FILES_HOVER_CLS : ''}`}
          >
            {node.name}
          </span>
        </span>
        {cached && (
          <span className="text-[10px] text-gray-500 shrink-0">{cached.rows.length} row{cached.rows.length !== 1 ? 's' : ''}</span>
        )}
        {loading && <RotateCw className="w-3 h-3 shrink-0 text-gray-500 animate-spin" />}
      </button>
      {open && (
        <div className="px-4 pb-3">
          {loading && <p className="text-xs text-gray-500 py-2">Running dbt show…</p>}
          {error && !loading && (
            <div className="flex items-center justify-between py-2">
              <p className="text-xs text-red-400">{error}</p>
              <button
                onClick={fetchRows}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-surface-elevated hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
              >
                <RotateCw className="w-3 h-3" /> Retry
              </button>
            </div>
          )}
          {!loading && !error && cached && cached.rows.length === 0 && (
            <p className="text-xs text-gray-600 py-2">No failing rows returned.</p>
          )}
          {!loading && !error && cached && cached.rows.length > 0 && (
            <div className="mt-1">
              <div className="flex justify-end mb-1">
                <button
                  onClick={fetchRows}
                  disabled={loading}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-surface-elevated hover:bg-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 transition-colors"
                >
                  <RotateCw className="w-2.5 h-2.5" /> Refresh
                </button>
              </div>
              <DataTable
                columns={cached.columns.map((c) => ({ key: c }))}
                rows={cached.rows}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
