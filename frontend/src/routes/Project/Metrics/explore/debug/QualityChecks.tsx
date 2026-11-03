// Debug tab: the quality checks, each with the SQL it ran, grouped by the step they're about
// (reading a table, a join). Only those steps have checks; the graph's other steps only reshape
// the query, and clicking any step just highlights its SQL (PlanSqlView).
import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { FindingDto } from '../../../../../lib/metricDebugApi';
import { useTheme } from '../../../../../lib/useTheme';
import { KIND_LABELS, stepPurpose, stepSummary, type PipelineStep } from '../../lib/debugView';
import { StatusIcon } from './DebugPlanGraph';

const LINK = 'flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-200';

function SqlView({ sql, height }: { sql: string; height: number }) {
  const theme = useTheme();
  return (
    <div className="rounded border border-gray-800 overflow-hidden" style={{ height }}>
      <Editor language="sql" value={sql} theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
        options={{ readOnly: true, domReadOnly: true, fontSize: 11, minimap: { enabled: false }, scrollBeyondLastLine: false,
          automaticLayout: true, lineNumbers: 'off', folding: false, padding: { top: 6 } }} />
    </div>
  );
}

export function FindingRow({ finding, onOpenInWorkspace, focus = 0 }: {
  finding: FindingDto; onOpenInWorkspace: (sql: string) => void;
  /** non-zero: scroll to it and flash it (a new value each time it's asked for) */
  focus?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!focus) return;
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [focus]);
  return (
    <li ref={ref} className={`py-1.5 -mx-2 px-2 rounded border-b border-gray-800/70 last:border-b-0 transition-colors duration-700 ${
      flash ? 'bg-brand-950/60 ring-1 ring-brand-600/60' : ''}`}>
      <div className="flex items-start gap-2">
        <StatusIcon status={finding.status} className="w-3.5 h-3.5 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-gray-200">{finding.title}</span>
            <span className="ml-auto text-[11px] tabular-nums text-gray-400 shrink-0">{finding.value}</span>
          </div>
          {finding.detail && <p className="text-[11px] text-gray-500 whitespace-pre-wrap">{finding.detail}</p>}
          {finding.sql && (
            <div className="flex items-center gap-3 mt-0.5">
              <button onClick={() => setOpen(!open)} className={LINK}>
                {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}Check SQL
              </button>
              <button onClick={() => onOpenInWorkspace(finding.sql!)} className={LINK}><ExternalLink className="w-3 h-3" />Open in Workspace</button>
            </div>
          )}
          {open && finding.sql && <div className="mt-1"><SqlView sql={finding.sql} height={160} /></div>}
        </div>
      </div>
    </li>
  );
}

/**
 * Every check, grouped by the plan step it's about (each table read, each join), worst group first;
 * then checks no step owns. Independent of the step selected in the graph, which only moves the SQL
 * highlight.
 */
export function QualityChecks({ steps, unplaced, onOpenInWorkspace, focus }: {
  /** the plan steps that have checks */
  steps: PipelineStep[];
  unplaced: FindingDto[];
  onOpenInWorkspace: (sql: string) => void;
  /** the check asked for (Show the check, an explanation's link): scrolled to and flashed */
  focus: { id: string; n: number } | null;
}) {
  const row = (f: FindingDto) => <FindingRow key={f.id} finding={f} onOpenInWorkspace={onOpenInWorkspace} focus={focus?.id === f.id ? focus.n : 0} />;
  return (
    <section aria-label="Quality checks" className="flex flex-col gap-3 min-w-0">
      <h4 className="text-xs font-semibold text-gray-100">Quality checks</h4>
      {!steps.length && !unplaced.length && <p className="text-[11px] text-gray-500">No checks apply to this query.</p>}
      {steps.map((step) => (
        <div key={step.node.id} className="flex flex-col gap-0.5">
          <h5 className="flex items-center gap-1.5 text-[11px] font-medium text-gray-300" title={stepPurpose(step.node)}>
            <StatusIcon status={step.status} className="w-3 h-3" />
            {KIND_LABELS[step.node.kind] ?? step.node.kind}<span className="font-normal text-gray-500">{stepSummary(step.node)}</span>
          </h5>
          <ul aria-label={`${KIND_LABELS[step.node.kind] ?? step.node.kind} checks`} className="pl-4">{step.findings.map(row)}</ul>
        </div>
      ))}
      {unplaced.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {steps.length > 0 && <h5 className="text-[11px] font-medium text-gray-300">Other</h5>}
          <ul aria-label="Other checks" className={steps.length ? 'pl-4' : ''}>{unplaced.map(row)}</ul>
        </div>
      )}
    </section>
  );
}
