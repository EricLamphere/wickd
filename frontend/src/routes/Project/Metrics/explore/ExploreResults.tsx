// Under the explorer's widget: the rows behind it (Table), the SQL MetricFlow generated (SQL),
// per query when the widget runs several (current / previous period, total / trend…), Debug
// (plan 15): the main query's plan and warehouse checks, run when the tab opens, and Compare
// (plan 14, Pro): the query run two ways, only once its options are set and Run is clicked.
import { useState } from 'react';
import Editor from '@monaco-editor/react';
import { Copy, ExternalLink } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import type { WidgetResultDto } from '../../../../lib/dashboardsApi';
import { useTheme } from '../../../../lib/useTheme';
import { mainQuery } from '../lib/exploreWidget';
import { ProLabel } from '../../../../components/ProLabel';
import { DebugPanel } from './debug/DebugPanel';

export const RESULT_TABS = ['debug', 'table', 'sql', 'compare'] as const;
export type ResultTab = (typeof RESULT_TABS)[number];
const TAB_LABELS: Record<ResultTab, React.ReactNode> = { table: 'Table', sql: 'SQL', debug: 'Debug', compare: <ProLabel>Compare</ProLabel> };
/** Tabs that size to their content rather than a fixed-height grid. */
const GROWS: readonly ResultTab[] = ['debug', 'compare'];
/** useStickyTab key of the results tab (a compare link presets it). */
export const resultsTabKey = (projectId: number) => `explore-results-tab:${projectId}`;

const ROLE_LABELS: Record<string, string> = {
  current: 'Current period', current_previous: 'Previous period', total: 'Total', total_previous: 'Total, previous period',
  trend: 'Trend', trend_previous: 'Trend, previous period',
};

export function ExploreResults({ projectId, result, loading, onOpenInWorkspace, onSetPeriod, tab, onTab, compare }: {
  projectId: number; result: WidgetResultDto | undefined; onOpenInWorkspace: (sql: string) => void;
  /** the query is still being planned (no result yet): the tabs say so instead of "pick a metric" */
  loading: boolean;
  /** Debug's period fixes */
  onSetPeriod: (range: { start: string; end: string }) => void;
  tab: ResultTab; onTab: (tab: ResultTab) => void;
  /** the Compare tab's content (the compare panel, or the Pro notice) */
  compare: React.ReactNode;
}) {
  const theme = useTheme();
  const setTab = onTab;
  const roles = Object.keys(result?.queries ?? {});
  const [picked, setPicked] = useState<string | null>(null);
  const role = picked && roles.includes(picked) ? picked : roles[0];
  const q = role ? result?.queries[role] : undefined;

  return (
    <div className={`flex flex-col min-h-[18rem] rounded border border-gray-800 bg-surface-panel ${GROWS.includes(tab) ? '' : 'h-80'}`}>
      <div className="flex items-center gap-1 px-2 border-b border-gray-800" role="tablist">
        {RESULT_TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`px-2.5 py-1.5 text-xs border-b-2 -mb-px ${tab === t ? 'border-brand-500 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {TAB_LABELS[t]}
          </button>
        ))}
        <div className="flex-1" />
        {roles.length > 1 && !GROWS.includes(tab) && (
          <select value={role} onChange={(e) => setPicked(e.target.value)} aria-label="Query"
            className="my-1 px-1.5 py-0.5 text-[11px] rounded border border-gray-700 bg-surface-app text-gray-300">
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
          </select>
        )}
        {tab === 'sql' && q?.sql && (
          <>
            <button onClick={() => navigator.clipboard?.writeText(q.sql!)} className="flex items-center gap-1 px-1.5 text-[11px] text-gray-400 hover:text-gray-200">
              <Copy className="w-3 h-3" />Copy
            </button>
            <button onClick={() => onOpenInWorkspace(q.sql!)} className="flex items-center gap-1 px-1.5 text-[11px] text-gray-400 hover:text-gray-200">
              <ExternalLink className="w-3 h-3" />Open in Workspace
            </button>
          </>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'compare' ? compare
          : tab === 'debug' ? <DebugPanel projectId={projectId} body={mainQuery(result)?.body ?? null} loading={loading} onOpenInWorkspace={onOpenInWorkspace} onSetPeriod={onSetPeriod} />
          : !q ? <p className="p-4 text-xs text-gray-500">{loading ? 'Loading…' : 'Pick a metric to see its rows and SQL.'}</p>
          : tab === 'table' ? (
            q.status === 'ok'
              ? <div className="h-full p-2"><DataTable className="h-full" columns={q.columns.map((c) => ({ key: c }))} rows={q.rows} /></div>
              : <p className="p-4 text-xs text-gray-500 whitespace-pre-wrap">{q.status === 'error' ? q.error : q.status === 'running' ? 'Running on the warehouse…' : 'Not run yet.'}</p>
          ) : q.sql ? (
            <Editor language="sql" value={q.sql} theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
              options={{ readOnly: true, domReadOnly: true, fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false,
                automaticLayout: true, lineNumbers: 'on', padding: { top: 8 } }} />
          ) : <p className="p-4 text-xs text-red-300 whitespace-pre-wrap">{q.error ?? 'No SQL for this query.'}</p>}
      </div>
    </div>
  );
}
