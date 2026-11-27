import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { api } from '../../../../lib/api';
import { DataTable } from '../../../../components/DataTable';

// ---------------------------------------------------------------------------
// FailedRowsPanel — runs dbt show on a failing test node
// ---------------------------------------------------------------------------

export type FailedRowsCache = Map<string, { columns: string[]; rows: unknown[][] }>;

// Module-level guard against duplicate dbt show runs for the same test (React StrictMode mounts
// twice in dev), like _previewInflight in index.tsx.
const _failedRowsInflight = new Set<string>();

interface FailedRowsPanelProps {
  projectId: number;
  model: { unique_id: string };
  failedRowsCache?: FailedRowsCache;
  onFailedRowsCached?: (uid: string, data: { columns: string[]; rows: unknown[][] }) => void;
}

export function FailedRowsPanel({ projectId, model, failedRowsCache, onFailedRowsCached }: FailedRowsPanelProps) {
  const key = `${projectId}:${model.unique_id}`;
  const cached = failedRowsCache?.get(model.unique_id) ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const peerInFlight = !cached && !loading && _failedRowsInflight.has(key);

  const fetchRows = async () => {
    if (_failedRowsInflight.has(key)) return;
    _failedRowsInflight.add(key);
    setLoading(true);
    setError(null);
    try {
      const result = await api.models.show(projectId, model.unique_id, 100);
      onFailedRowsCached?.(model.unique_id, result);
    } catch (e) {
      setError(String(e));
    } finally {
      _failedRowsInflight.delete(key);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!cached && !_failedRowsInflight.has(key)) {
      fetchRows();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
        <span className="text-xs text-gray-500">{cached ? `${cached.rows.length} row${cached.rows.length !== 1 ? 's' : ''}` : ' '}</span>
        <button
          onClick={fetchRows}
          disabled={loading || peerInFlight}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-surface-elevated hover:bg-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 transition-colors"
          title="Re-run dbt show"
        >
          <RotateCw className={`w-3 h-3 ${loading || peerInFlight ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {(loading || peerInFlight) && (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Running dbt show…
          </div>
        )}
        {error && !loading && !peerInFlight && (
          <div className="flex items-center justify-center h-full text-red-400 text-sm px-4 text-center">
            {error}
          </div>
        )}
        {!loading && !peerInFlight && !error && cached && cached.rows.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            No failing rows
          </div>
        )}
        {!loading && !peerInFlight && !error && cached && cached.rows.length > 0 && (
          <DataTable
            columns={cached.columns.map((c) => ({ key: c }))}
            rows={cached.rows}
          />
        )}
      </div>
    </div>
  );
}
