// Shown instead of the explorer when MetricFlow can't run here: off, an incompatible
// dbt-core (opens plan 07's version dialog), an unsupported adapter, or first-use setup.
import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { semanticApi, type SemanticStatusDto } from '../../../lib/semanticApi';
import { MetricFlowCompatDialog } from '../components/semantic/MetricFlowCompatDialog';
import { INCOMPATIBLE_REASONS } from '../components/semantic/semanticView';
import { useSetMetricflowMode, useSidecarProgress } from '../components/semantic/useSemantic';

const LINK_CLS = 'ml-2 text-brand-300 hover:text-brand-200 underline-offset-2 hover:underline';

export function MetricsUnavailable({ projectId, status }: { projectId: number; status: SemanticStatusDto }) {
  const setMode = useSetMetricflowMode(projectId);
  const sidecar = useSidecarProgress();
  const [dialog, setDialog] = useState<SemanticStatusDto | null>(null);
  const incompatible = !!status.reason_code && INCOMPATIBLE_REASONS.has(status.reason_code);

  const enable = () => setMode.mutate('auto', {
    onSuccess: async () => {
      const fresh = await semanticApi.status(projectId);
      if (fresh.reason_code && INCOMPATIBLE_REASONS.has(fresh.reason_code)) setDialog(fresh);
    },
  });

  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full p-8 text-center">
      <h2 className="text-sm font-medium text-gray-200">Metrics need MetricFlow</h2>
      <p className="max-w-md text-xs text-gray-400 leading-relaxed">
        {status.mode === 'off'
          ? `MetricFlow is off ${status.mode_source === 'project' ? 'for this project' : 'by default (Global Settings)'}.`
          : status.reason ?? "MetricFlow can't query this project yet."}
        {status.mode === 'off' && (
          <button onClick={enable} disabled={setMode.isPending} className={LINK_CLS}>Enable MetricFlow</button>
        )}
        {status.mode !== 'off' && incompatible && (
          <button onClick={() => setDialog(status)} className={LINK_CLS}>Choose a dbt-core version…</button>
        )}
      </p>
      {status.warning && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-300"><AlertTriangle className="w-3 h-3" />{status.warning}</p>
      )}
      {sidecar && (
        <p className="flex items-center gap-1.5 text-[11px] text-brand-300">
          <Loader2 className="w-3 h-3 animate-spin" />Setting up MetricFlow (first use, about a minute): {sidecar.message}
        </p>
      )}
      {dialog && <MetricFlowCompatDialog projectId={projectId} status={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
