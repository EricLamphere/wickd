// Results of a metric query: Chart / Table / SQL tabs (local state, like other panes).
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { AlertTriangle, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { DataTable } from '../../../components/DataTable';
import type { MetricQueryResultDto } from '../../../lib/semanticApi';
import { useTheme } from '../../../lib/useTheme';
import { useStickyTab } from '../../../lib/useUrlTab';
import { relativeTime } from '../lib/relativeTime';
import { MetricPanels } from './MetricChart';
import { buildPanels, type ShapeOptions } from './lib/metricSeries';

const TABS = ['chart', 'table', 'sql'] as const;
type Tab = (typeof TABS)[number];

interface Props {
  result: MetricQueryResultDto | null;
  loadingResult: boolean;
  sql: string | null;
  sqlError: string | null;
  runError: string | null;
  running: boolean;
  definitionsChanged: boolean;
  shape: ShapeOptions;
  grain: string;
  /** Hint shown when the result was truncated (e.g. a coarser grain) */
  truncatedHint: string | null;
  onRun: () => void;
  onOpenInWorkspace: (sql: string) => void;
}

function StatusLine({ result }: { result: MetricQueryResultDto }) {
  const parts = [
    `${result.source === 'cache' ? 'Last run' : 'Ran'} ${relativeTime(result.ran_at)}`,
    `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? '' : 's'}`,
    `${(result.elapsed_ms / 1000).toFixed(1)}s`,
    result.target ? `target ${result.target}` : null,
    result.profile_name ? `profile ${result.profile_name}` : null,
  ].filter(Boolean);
  return <span className="text-[11px] text-gray-500">{parts.join(' · ')}</span>;
}

function SqlView({ sql, error, onOpenInWorkspace }: { sql: string | null; error: string | null; onOpenInWorkspace: (sql: string) => void }) {
  const theme = useTheme();
  if (error) return <p className="p-4 text-xs text-red-400 whitespace-pre-wrap">{error}</p>;
  if (!sql) return <p className="p-4 text-xs text-gray-500">Pick a metric to see the SQL MetricFlow generates.</p>;
  return (
    <div className="flex flex-col h-full min-h-[20rem]">
      <div className="flex justify-end gap-2 px-3 py-1.5 border-b border-gray-800">
        <button onClick={() => navigator.clipboard?.writeText(sql)} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200">
          <Copy className="w-3 h-3" />Copy
        </button>
        <button onClick={() => onOpenInWorkspace(sql)} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200">
          <ExternalLink className="w-3 h-3" />Open in Workspace
        </button>
      </div>
      <div className="flex-1">
        <Editor language="sql" value={sql} theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
          options={{ readOnly: true, domReadOnly: true, fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false,
            automaticLayout: true, lineNumbers: 'on', padding: { top: 8 } }} />
      </div>
    </div>
  );
}

export function ResultsPane(props: Props) {
  const { result, loadingResult, sql, sqlError, runError, running, definitionsChanged, shape, grain, truncatedHint, onRun, onOpenInWorkspace } = props;
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useStickyTab<Tab>(`metrics-results-tab:${projectId}`, TABS, 'chart');
  const panels = useMemo(() => (result ? buildPanels(result.columns, result.rows, shape) : []), [result, shape]);

  const body = () => {
    if (tab === 'sql') return <SqlView sql={sql} error={sqlError} onOpenInWorkspace={onOpenInWorkspace} />;
    if (running && !result) return <p className="flex items-center gap-2 p-6 text-xs text-brand-300"><Loader2 className="w-3.5 h-3.5 animate-spin" />Running on the warehouse…</p>;
    if (loadingResult) return <p className="p-6 text-xs text-gray-500">Loading…</p>;
    if (!result) {
      return <p className="p-6 text-xs text-gray-500">{sqlError ? 'Fix the query to run it.' : 'Not run yet with this target. Press Run (⌘↵) to query the warehouse.'}</p>;
    }
    if (tab === 'table') {
      return <div className="h-full min-h-[20rem]"><DataTable columns={result.columns.map((c) => ({ key: c }))} rows={result.rows} /></div>;
    }
    return <div className="p-4"><MetricPanels panels={panels} grain={grain} /></div>;
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-3 px-4 border-b border-gray-800">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`py-2 text-xs capitalize border-b-2 -mb-px ${tab === t ? 'border-brand-500 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {t === 'sql' ? 'SQL' : t}
          </button>
        ))}
        <div className="flex-1" />
        {running && result && <span className="flex items-center gap-1 text-[11px] text-brand-300"><Loader2 className="w-3 h-3 animate-spin" />Running…</span>}
        {result && <StatusLine result={result} />}
      </div>
      {definitionsChanged && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] bg-amber-950/30 text-amber-300 border-b border-amber-900/40">
          <RefreshCw className="w-3 h-3" />Definitions changed since this ran.
          <button onClick={onRun} className="underline underline-offset-2 hover:text-amber-200">Re-run</button>
        </div>
      )}
      {runError && <p className="px-4 py-2 text-xs text-red-400 whitespace-pre-wrap border-b border-gray-800">{runError}</p>}
      {result?.truncated && (
        <p className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-amber-300 border-b border-gray-800">
          <AlertTriangle className="w-3 h-3" />Showing the first {result.rows.length.toLocaleString()} rows.{truncatedHint ? ` ${truncatedHint}` : ''}
        </p>
      )}
      <div className="flex-1 min-h-0 overflow-auto">{body()}</div>
    </div>
  );
}
