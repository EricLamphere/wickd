// Debug tab: how MetricFlow computes the number, as a small left-to-right graph of its plan
// (read → metric time → time range → join → filter → aggregate → compute; ratio and derived
// metrics branch per input). Each box says what the step does with your names; checked steps
// carry their status. Click any box to highlight its part of the SQL.
import { AlertTriangle, Check, CircleSlash, Info, Loader2, XCircle } from 'lucide-react';
import type { FindingStatus } from '../../../../../lib/metricDebugApi';
import { KIND_LABELS, isProblem, stepPurpose, stepSummary, type PipelineStep } from '../../lib/debugView';
import { layoutPlan, PLAN_NODE_H, PLAN_NODE_W } from '../../lib/planGraph';

export const STATUS_TONE: Record<FindingStatus, string> = {
  fail: 'text-red-400', error: 'text-red-400', warn: 'text-amber-400', ok: 'text-emerald-400',
  info: 'text-gray-400', skipped: 'text-gray-500', not_run: 'text-gray-500',
};

export function StatusIcon({ status, className = 'w-3.5 h-3.5' }: { status: FindingStatus | null; className?: string }) {
  if (status === null) return <span className={`${className} inline-block`} />;
  const tone = `${className} shrink-0 ${STATUS_TONE[status]}`;
  if (status === 'fail' || status === 'error') return <XCircle className={tone} aria-label={status} />;
  if (status === 'warn') return <AlertTriangle className={tone} aria-label="warning" />;
  if (status === 'ok') return <Check className={tone} aria-label="ok" />;
  if (status === 'not_run') return <Loader2 className={tone} aria-label="not run" />;
  if (status === 'skipped') return <CircleSlash className={tone} aria-label="skipped" />;
  return <Info className={tone} aria-label="info" />;
}

function boxTone(step: PipelineStep, active: boolean): string {
  if (active) return 'border-brand-500 bg-brand-950/50 ring-1 ring-brand-500/40';
  if (isProblem(step.status)) return 'border-amber-700/80 bg-amber-950/30 hover:border-amber-500';
  if (step.findings.length) return 'border-gray-600 bg-surface-panel hover:border-gray-400';
  return 'border-gray-800 bg-surface-app hover:border-gray-600';
}

export function PlanGraph({ steps, selected, onSelect }: {
  steps: PipelineStep[]; selected: string | null; onSelect: (id: string) => void;
}) {
  const layout = layoutPlan(steps.map((s) => s.node));
  const byId = new Map(steps.map((s) => [s.node.id, s]));
  const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  return (
    <section aria-label="How MetricFlow computes it" className="flex flex-col gap-1.5">
      <h4 className="text-[11px] font-medium text-gray-400">How MetricFlow computes it <span className="font-normal text-gray-600">· click a step to highlight its part of the SQL</span></h4>
      <div className="overflow-x-auto rounded border border-gray-800 bg-surface-app/60">
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
            <defs>
              <marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="rgb(var(--gray-600))" />
              </marker>
            </defs>
            {layout.edges.map((e) => (
              <path key={`${e.from}>${e.to}`} d={path(e.points)} fill="none" stroke="rgb(var(--gray-600))" strokeWidth={1.25} markerEnd="url(#plan-arrow)" />
            ))}
          </svg>
          {layout.nodes.map((n) => {
            const step = byId.get(n.id)!;
            const active = n.id === selected;
            return (
              <button key={n.id} onClick={() => onSelect(n.id)} aria-current={active} title={stepPurpose(step.node)}
                style={{ left: n.x, top: n.y, width: PLAN_NODE_W, height: PLAN_NODE_H }}
                className={`absolute flex flex-col justify-center gap-0.5 px-2 text-left rounded-md border transition-colors ${boxTone(step, active)}`}>
                <span className="flex items-center gap-1 text-[11px] font-medium text-gray-100">
                  {KIND_LABELS[step.node.kind] ?? step.node.kind}
                  {step.findings.length > 0 && <StatusIcon status={step.status} className="w-3 h-3" />}
                </span>
                <span className="text-[10px] leading-tight text-gray-400 truncate">{stepSummary(step.node)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
