// Under the explorer's widget: the rows behind it (Table) and the SQL MetricFlow generated
// (SQL), per query when the widget runs several (current / previous period, total / trend…).
import { useState } from 'react';
import Editor from '@monaco-editor/react';
import { Copy, ExternalLink } from 'lucide-react';
import { DataTable } from '../../../../components/DataTable';
import type { WidgetResultDto } from '../../../../lib/dashboardsApi';
import { useTheme } from '../../../../lib/useTheme';
import { useStickyTab } from '../../../../lib/useUrlTab';

const TABS = ['table', 'sql'] as const;
type Tab = (typeof TABS)[number];

const ROLE_LABELS: Record<string, string> = {
  current: 'Current period', current_previous: 'Previous period', total: 'Total', total_previous: 'Total, previous period',
  trend: 'Trend', trend_previous: 'Trend, previous period',
};

export function ExploreResults({ projectId, result, onOpenInWorkspace }: {
  projectId: number; result: WidgetResultDto | undefined; onOpenInWorkspace: (sql: string) => void;
}) {
  const theme = useTheme();
  const [tab, setTab] = useStickyTab<Tab>(`explore-results-tab:${projectId}`, TABS, 'table');
  const roles = Object.keys(result?.queries ?? {});
  const [picked, setPicked] = useState<string | null>(null);
  const role = picked && roles.includes(picked) ? picked : roles[0];
  const q = role ? result?.queries[role] : undefined;

  return (
    <div className="flex flex-col min-h-[18rem] h-80 rounded border border-gray-800 bg-surface-panel">
      <div className="flex items-center gap-1 px-2 border-b border-gray-800" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`px-2.5 py-1.5 text-xs border-b-2 -mb-px ${tab === t ? 'border-brand-500 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {t === 'table' ? 'Table' : 'SQL'}
          </button>
        ))}
        <div className="flex-1" />
        {roles.length > 1 && (
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
        {!q ? <p className="p-4 text-xs text-gray-500">Pick a metric to see its rows and SQL.</p>
          : tab === 'table' ? (
            q.status === 'ok'
              ? <div className="h-full p-2"><DataTable className="h-full" columns={q.columns.map((c) => ({ key: c }))} rows={q.rows} /></div>
              : <p className="p-4 text-xs text-gray-500">{q.status === 'error' ? q.error : 'Not run yet.'}</p>
          ) : q.sql ? (
            <Editor language="sql" value={q.sql} theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
              options={{ readOnly: true, domReadOnly: true, fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false,
                automaticLayout: true, lineNumbers: 'on', padding: { top: 8 } }} />
          ) : <p className="p-4 text-xs text-red-300 whitespace-pre-wrap">{q.error ?? 'No SQL for this query.'}</p>}
      </div>
    </div>
  );
}
