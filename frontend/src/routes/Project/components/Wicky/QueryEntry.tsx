import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, MessageSquareText, Play } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import { aiApi, aiErrorMessage, type AiMessageDto, type AiQueryPayload } from '../../../../lib/aiApi';

interface QueryEntryProps {
  projectId: number;
  message: AiMessageDto;
  /** Stream an answer from this query's results into the chat. */
  onAnswer: () => void;
  /** An answer (or anything else) is streaming; don't start another. */
  busy: boolean;
}

const RUNNING = new Set(['waiting', 'running']);

/**
 * SQL Wicky wrote for a data question: review (and edit) it, run it, see the rows,
 * then have Wicky answer from them. Nothing reaches the warehouse until Run.
 */
export function QueryEntry({ projectId, message, onAnswer, busy }: QueryEntryProps) {
  const qc = useQueryClient();
  const payload = message.payload as AiQueryPayload;
  const [sql, setSql] = useState(payload.sql);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const status = useQuery({ queryKey: ['ai-status'], queryFn: aiApi.status }).data;
  const running = RUNNING.has(payload.status) || starting;

  // follow the server's copy (e.g. the cleaned SQL after a run) unless the user is mid-edit
  useEffect(() => { if (!running) setSql(payload.sql); }, [payload.sql]); // eslint-disable-line react-hooks/exhaustive-deps

  // with the bundled model nothing leaves the machine, so answer as soon as results arrive
  const previous = useRef(payload.status);
  useEffect(() => {
    const was = previous.current;
    previous.current = payload.status;
    if (RUNNING.has(was) && payload.status === 'done' && status && !status.uses_endpoint && !busy) onAnswer();
  }, [payload.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setStarting(true);
    setError(null);
    try {
      await aiApi.runQuery(projectId, message.id, sql);
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setStarting(false);
      qc.invalidateQueries({ queryKey: ['ai-conversation', projectId] });
    }
  };

  const shownError = error ?? payload.error;
  const rows = payload.rows ?? [];

  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg border border-gray-800 bg-surface-elevated/40 text-gray-300">
      {message.content && <p>{message.content}</p>}
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        readOnly={running}
        spellCheck={false}
        rows={Math.min(12, sql.split('\n').length + 1)}
        className="w-full resize-y px-2 py-1.5 rounded bg-surface-panel border border-gray-800 font-mono text-[11px] text-gray-200 focus:outline-none focus:border-brand-500"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={run}
          disabled={running || !sql.trim()}
          title="Run with dbt show (read-only, at most 100 rows)"
          className="flex items-center gap-1 px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
        >
          {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          {payload.status === 'done' || payload.status === 'error' ? 'Run again' : 'Run'}
        </button>
        <span className="text-gray-500">
          {payload.status === 'waiting' && 'Waiting for the current dbt command to finish…'}
          {payload.status === 'running' && 'Running in the warehouse…'}
          {payload.status === 'done' && `${rows.length}${payload.truncated ? '+' : ''} row${rows.length === 1 ? '' : 's'}`}
          {payload.status === 'proposed' && 'Review the SQL, then run it.'}
        </span>
      </div>
      {shownError && (
        <p className="flex items-start gap-1.5 text-red-400 break-words whitespace-pre-wrap">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {shownError}
        </p>
      )}
      {payload.status === 'done' && payload.columns && (
        <>
          {rows.length > 0 && (
            <div className="max-h-64 overflow-auto rounded border border-gray-800">
              <DataTable columns={payload.columns.map((c) => ({ key: c }))} rows={rows} />
            </div>
          )}
          {payload.truncated && <span className="text-gray-500">Showing the first {rows.length} rows.</span>}
          <div className="flex items-center gap-2">
            <button
              onClick={onAnswer}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-elevated border border-gray-700 text-gray-200 hover:bg-gray-700 disabled:opacity-50"
            >
              <MessageSquareText size={12} className="text-brand-300" /> Answer from results
            </button>
            {status?.uses_endpoint && (
              <span className="text-amber-400/80">These rows will be sent to {status.endpoint_url}.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
