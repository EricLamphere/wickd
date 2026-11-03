// Debug tab: "Reconcile with SQL" — MetricFlow's SQL for the metric beside a plain query that
// should equal it (editable, drafted from the definition), run both, and see the keys where they
// differ. The SQL is kept per query for the session.
import { useState } from 'react';
import Editor from '@monaco-editor/react';
import { Loader2, Play } from 'lucide-react';
import { DataTable } from '../../../../../components/DataTable';
import type { MetricQueryBody } from '../../../../../lib/semanticApi';
import { useTheme } from '../../../../../lib/useTheme';
import { errorText } from '../../dashboards/useDashboards';
import { hasPlaceholders } from '../../lib/reconcileDraft';
import { useReconcile } from './useMetricDebug';

function draftKey(projectId: number, body: MetricQueryBody): string {
  return `metric-reconcile-sql:v3:${projectId}:${JSON.stringify(body.metrics ?? [])}:${JSON.stringify(body.group_by ?? [])}`;
}

function readDraft(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function writeDraft(key: string, sql: string): void {
  try { sessionStorage.setItem(key, sql); } catch { /* storage unavailable: the draft just isn't kept */ }
}

/** Remount it (key) when the query's metrics or group-bys change: the draft is per query. */
const EDITOR = { fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, lineNumbers: 'on' as const, padding: { top: 6 } };

function Pane({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-baseline gap-2">
        <h5 className="text-[11px] font-semibold text-gray-200">{title}</h5>
        <span className="text-[10px] text-gray-500 truncate">{hint}</span>
      </div>
      <div className="rounded border border-gray-800 overflow-hidden h-64">{children}</div>
    </div>
  );
}

export function ReconcilePanel({ projectId, body, initialSql, metricSql }: {
  projectId: number; body: MetricQueryBody; initialSql: string;
  /** MetricFlow's SQL for the metric (null while the debug result loads) */
  metricSql: string | null;
}) {
  const theme = useTheme();
  const key = draftKey(projectId, body);
  const [sql, setSql] = useState(() => readDraft(key) ?? initialSql);
  const reconcile = useReconcile(projectId);

  const unfinished = hasPlaceholders(sql);
  const run = () => reconcile.mutate({ body, sql });
  const result = reconcile.data;
  const s = result?.summary;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-gray-500">
        Check the metric against your own calculation. <span className="text-gray-300">Run and compare</span> runs two
        queries — the metric (MetricFlow’s SQL, left; its stored result when there is one) and your SQL (right) —
        then matches their rows on the group-by columns and lists the rows where the numbers differ. The draft is written
        from the metric's definition without MetricFlow; edit it to the calculation you trust.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        <Pane title="MetricFlow’s SQL" hint="the metric, as MetricFlow generates it · read-only">
          {metricSql
            ? <Editor language="sql" value={metricSql} theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
                options={{ ...EDITOR, readOnly: true, domReadOnly: true }} />
            : <p className="p-3 text-[11px] text-gray-500">Loading…</p>}
        </Pane>
        <Pane title="Your SQL" hint="the calculation you trust · edit it">
          <Editor language="sql" value={sql} theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
            onChange={(v) => { setSql(v ?? ''); writeDraft(key, v ?? ''); }} options={EDITOR} />
        </Pane>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={run} disabled={reconcile.isPending || !sql.trim() || unfinished}
          title={unfinished ? 'Replace each … with SQL first' : 'Run the metric and this SQL, then compare them row by row'}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
          {reconcile.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run and compare
        </button>
        {unfinished && <span className="text-[11px] text-amber-300">Replace each … with SQL to run it.</span>}
        {s && !unfinished && (
          <span className={`text-[11px] ${s.different + s.only_metric + s.only_sql ? 'text-amber-300' : 'text-emerald-300'}`}>
            {s.different + s.only_metric + s.only_sql === 0
              ? `All ${s.keys} rows match.`
              : `${s.matching} of ${s.keys} match · ${s.different} differ · ${s.only_metric} only in the metric · ${s.only_sql} only in your SQL`}
            {result?.sql_truncated && ' (your SQL returned more than 5,000 rows; only those were compared)'}
          </span>
        )}
        {reconcile.error && <span className="text-[11px] text-red-300 whitespace-pre-wrap">{errorText(reconcile.error)}</span>}
      </div>
      {result && result.rows.length > 0 && (
        <div className="h-56">
          <DataTable className="h-full" columns={result.columns.map((c) => ({ key: c, align: c.endsWith(')') || c.endsWith('difference') ? 'right' : 'left' }))}
            rows={result.rows} />
        </div>
      )}
    </div>
  );
}
