import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LineChart, Loader2, MessageSquareText, Pencil, Play, Sigma } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import { aiApi, aiErrorMessage, type AiMessageDto, type AiQueryPayload } from '../../../../lib/aiApi';
import type { MetricQueryBody } from '../../../../lib/semanticApi';
import { exploreUrl, requestSearch } from '../../Metrics/lib/exploreLink';
import { filterLabel } from '../../Metrics/lib/metricQuery';

interface QueryEntryProps {
  projectId: number;
  message: AiMessageDto;
  /** Stream an answer from this query's results into the chat. */
  onAnswer: () => void;
  /** An answer (or anything else) is streaming; don't start another. */
  busy: boolean;
}

const RUNNING = new Set(['waiting', 'running']);
const CHIP = 'px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800/60 font-mono text-[10px] text-gray-300';

/** What a metric answer asks MetricFlow for: metrics, group-bys, filters, period. */
function MetricRequest({ request, onExplore }: { request: MetricQueryBody; onExplore: () => void }) {
  const period = [request.start, request.end].some(Boolean) ? `${request.start || '…'} – ${request.end || '…'}` : null;
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-[11px] text-brand-300">
        <Sigma size={12} /> Answered with your defined metrics, so the numbers match their definitions.
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {(request.metrics ?? []).map((m) => <span key={m} className={`${CHIP} text-brand-200`}>{m}</span>)}
        {(request.group_by ?? []).length > 0 && <span className="text-[10px] text-gray-500">by</span>}
        {(request.group_by ?? []).map((g) => <span key={g} className={CHIP}>{g}</span>)}
        {(request.where ?? []).map((w) => <span key={w} className={CHIP} title={w}>{filterLabel(w)}</span>)}
        {period && <span className={CHIP}>{period}</span>}
        <button onClick={onExplore} className="ml-auto flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200">
          <LineChart size={11} /> Open in explorer
        </button>
      </div>
    </div>
  );
}

/**
 * SQL Wicky wrote for a data question: review (and edit) it, run it, see the rows,
 * then have Wicky answer from them. Nothing reaches the warehouse until Run.
 */
export function QueryEntry({ projectId, message, onAnswer, busy }: QueryEntryProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const payload = message.payload as AiQueryPayload;
  const request = payload.metric_request;
  const [sql, setSql] = useState(payload.sql);
  // a metric answer's SQL is MetricFlow's: read-only until the user chooses to edit it as SQL
  const [editing, setEditing] = useState(!request);
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
      {request && <MetricRequest request={request} onExplore={() => navigate(exploreUrl(projectId, requestSearch(request)))} />}
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        readOnly={running || !editing}
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
        {request && !editing && (
          <button
            onClick={() => setEditing(true)}
            title="Edit the SQL by hand; it then runs as plain SQL instead of through the metric definitions"
            className="flex items-center gap-1 px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-700"
          >
            <Pencil size={11} /> Edit as SQL
          </button>
        )}
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
