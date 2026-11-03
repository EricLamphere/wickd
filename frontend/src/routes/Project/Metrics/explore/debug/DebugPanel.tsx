// The explorer's Debug tab (plan 15): MetricFlow's plan for the query as a pipeline of steps with
// the warehouse checks on each (input rows, filter, nulls, time coverage; join fan-out and
// unmatched rows; dimension nulls and spellings), the problems listed first as what they mean and
// what to do (lib/debugView conclusion(); a time-coverage problem offers a period fix), Reconcile with SQL,
// and — Pro — "Explain this number".
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Square } from 'lucide-react';
import type { FindingDto } from '../../../../../lib/metricDebugApi';
import type { MetricQueryBody } from '../../../../../lib/semanticApi';
import { errorText } from '../../dashboards/useDashboards';
import { conclusion, costNote, defaultStep, KIND_LABELS, pipeline, stepSummary, worstFirst } from '../../lib/debugView';
import { sqlSpanFor } from '../../lib/planGraph';
import { reconcileDraft } from '../../lib/reconcileDraft';
import { PlanGraph, StatusIcon } from './DebugPlanGraph';
import { PlanSqlView } from './PlanSqlView';
import { QualityChecks } from './QualityChecks';
import { ExplainNumberButton, Explanation, useExplainState } from './ExplainNumber';
import { ReconcilePanel } from './ReconcilePanel';
import { debuggable, useMetricDebug } from './useMetricDebug';

const BTN = 'flex items-center gap-1.5 px-2 py-1 text-[11px] rounded border border-gray-700 text-gray-300 hover:border-gray-500 disabled:opacity-40';

export function DebugPanel({ projectId, body, onOpenInWorkspace, onSetPeriod }: {
  projectId: number; body: MetricQueryBody | null; onOpenInWorkspace: (sql: string) => void;
  /** a problem's fix: the query's period set to this range (null where the period can't be changed) */
  onSetPeriod: ((range: { start: string; end: string }) => void) | null;
}) {
  const debug = useMetricDebug(projectId, body, true);
  const explain = useExplainState(projectId);
  const [picked, setPicked] = useState<string | null>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const data = debug.data;
  const { steps, unplaced } = useMemo(() => (data ? pipeline(data) : { steps: [], unplaced: [] }), [data]);
  // the step whose SQL is highlighted (any can be picked); first the first problem's
  const checked = useMemo(() => steps.filter((s) => s.findings.length > 0), [steps]);
  const selectedId = picked && steps.some((s) => s.node.id === picked) ? picked : defaultStep(checked) ?? defaultStep(steps);
  const selected = steps.find((s) => s.node.id === selectedId) ?? null;
  const span = useMemo(() => (data && selectedId ? sqlSpanFor(data, selectedId) : null), [data, selectedId]);

  // the check asked for (Show the check, an explanation's link); every hook stays above the early return below
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);

  const savedQuery = !!body?.saved_query;
  if (!debuggable(body)) {
    return <p className="p-4 text-xs text-gray-500">{savedQuery
      ? 'Debug works on metrics: pick the saved query’s metrics in Configure to debug them.'
      : 'Pick a metric to debug it.'}</p>;
  }
  // Show the check / an explanation's link: its step selected, the check scrolled to and flashed
  // (even when its step is already the one shown — the usual case, as the first problem's step is the default)
  const showFinding = (f: FindingDto) => {
    if (f.node) setPicked(f.node);
    setFocus((cur) => ({ id: f.id, n: (cur?.n ?? 0) + 1 }));
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {data && <span className="text-[11px] text-gray-500">{costNote(data)}</span>}
        {debug.running && <span className="flex items-center gap-1 text-[11px] text-gray-400"><Loader2 className="w-3 h-3 animate-spin" />Running checks…</span>}
        <div className="flex-1" />
        {debug.running
          ? <button onClick={debug.cancel} className={BTN} title="Stop the check queries"><Square className="w-3 h-3" />Cancel</button>
          : <button onClick={debug.rerun} disabled={!data} className={BTN} title="Run every check on the warehouse again"><RefreshCw className="w-3 h-3" />Rerun checks</button>}
        <ExplainNumberButton onClick={() => explain.start(body)} busy={explain.busy || debug.running || !data} />
      </div>
      {debug.error != null && <p className="text-[11px] text-red-300">{errorText(debug.error)}</p>}
      <Explanation data={explain.data} error={explain.error} findings={data?.checks ?? []} onShowFinding={showFinding} />
      {data && data.warnings.length > 0 && (
        <section aria-label="Problems" className="flex flex-col gap-2 px-3 py-2.5 rounded border border-amber-900/50 bg-amber-950/20">
          {data.warnings.map((w) => {
            const c = conclusion(w);
            return (
              <div key={w.id} className="flex items-start gap-2">
                <StatusIcon status={w.status} className="w-3.5 h-3.5 mt-0.5" />
                <div className="flex flex-col gap-1 min-w-0">
                  <p className="text-xs font-medium text-gray-100">{c.headline}</p>
                  <p className="text-[11px] text-gray-400">{c.advice}</p>
                  <div className="flex flex-wrap items-center gap-3">
                    {c.action && onSetPeriod && (
                      <button onClick={() => onSetPeriod(c.action!.range)} className={BTN}>{c.action.label}</button>
                    )}
                    <button onClick={() => showFinding(w)} className="text-[11px] text-brand-300 hover:text-brand-200">Show the check</button>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}
      {data && data.warnings.length === 0 && !debug.running && (
        <p className="text-[11px] text-emerald-300">No problems found in {data.queries} check {data.queries === 1 ? 'query' : 'queries'}.</p>
      )}
      {data?.plan_error && <p className="text-[11px] text-amber-300">MetricFlow’s plan isn’t available ({data.plan_error}); its steps come from the SQL’s comments.</p>}
      {data && steps.length > 0 && <PlanGraph steps={steps} selected={selectedId} onSelect={setPicked} />}
      {data && steps.length === 0 && data.steps.length > 0 && (
        <p className="text-[11px] text-gray-500">MetricFlow’s steps: {data.steps.map((s) => s.labels.join(' · ')).join(' → ')}</p>
      )}
      {data && (
        <div className="grid gap-4 min-h-0 xl:grid-cols-2">
          <QualityChecks steps={[...checked].sort((a, b) => worstFirst(a.status, b.status))} unplaced={unplaced}
            onOpenInWorkspace={onOpenInWorkspace} focus={focus} />
          {data.sql && (
            <PlanSqlView sql={data.sql} span={span} onOpenInWorkspace={onOpenInWorkspace}
              stepName={selected ? `${KIND_LABELS[selected.node.kind] ?? selected.node.kind} · ${stepSummary(selected.node)}` : null} />
          )}
        </div>
      )}
      {data && data.notes.length > 0 && (
        <ul className="flex flex-col gap-0.5">{data.notes.map((n) => <li key={n} className="text-[10px] text-gray-500">{n}</li>)}</ul>
      )}
      <div className="border-t border-gray-800 pt-2">
        <button onClick={() => setReconcileOpen(!reconcileOpen)} className="flex items-center gap-1 text-xs text-gray-300 hover:text-gray-100">
          {reconcileOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}Reconcile with SQL
        </button>
        {reconcileOpen && (
          <div className="mt-2">
            <ReconcilePanel key={`${JSON.stringify(body.metrics)}:${JSON.stringify(body.group_by ?? [])}:${data ? 'ready' : 'loading'}`} projectId={projectId}
              body={body} initialSql={reconcileDraft(body, data)} metricSql={data?.sql ?? null} />
          </div>
        )}
      </div>
      {explain.modal}
    </div>
  );
}
