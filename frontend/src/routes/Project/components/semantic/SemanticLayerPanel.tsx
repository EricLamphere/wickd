import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { semanticApi, semanticErrorBody, type SemanticStatusDto } from '../../../../lib/semanticApi';
import { relativeTime } from '../../lib/relativeTime';
import RunButton from '../health/RunButton';
import StaleNotice from '../health/StaleNotice';
import { errorMessage, useHealthRuns, useHealthSummary, useIsStarting } from '../health/useHealth';
import { MetricFlowCompatDialog } from './MetricFlowCompatDialog';
import { SemanticIssues } from './SemanticIssues';
import { statusLine } from './semanticView';
import { useSemanticCheck, useSemanticStatus, useSetMetricflowMode, useSidecarProgress } from './useSemantic';

const INCOMPATIBLE = new Set(['too_old', 'latest_spec_needs_1_12', 'no_cli_release', 'unknown_version']);

interface DialogState {
  status: SemanticStatusDto;
  wantCli: boolean;
}

/** Health → Semantic Layer: MetricFlow validations, optionally against the warehouse. */
export default function SemanticLayerPanel({ projectId }: { projectId: number }) {
  const { data: status, isLoading, error } = useSemanticStatus(projectId);
  const { data: check } = useSemanticCheck(projectId);
  const { data: summary } = useHealthSummary(projectId);
  const runs = useHealthRuns(projectId);
  const starting = useIsStarting('semantic', projectId);
  const sidecar = useSidecarProgress();
  const setMode = useSetMetricflowMode(projectId);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  if (isLoading) return <p className="p-6 text-xs text-gray-600">Loading…</p>;
  if (error || !status) return <p className="p-6 text-xs text-red-400">Couldn't load the semantic layer status: {errorMessage(error)}</p>;

  const running = starting || check?.status === 'running';
  const runError = runs.semantic.error;
  const blocked = semanticErrorBody(runError);

  const run = (warehouse: boolean) => runs.semantic.mutate(warehouse, {
    onError: (err) => {
      const body = semanticErrorBody(err);
      if (body?.status && INCOMPATIBLE.has(body.error)) setDialog({ status: body.status, wantCli: false });
    },
  });

  // Enabling reopens the version dialog when this dbt-core still can't run MetricFlow
  const enable = () => setMode.mutate('auto', {
    onSuccess: async () => {
      const fresh = await semanticApi.status(projectId);
      if (fresh.reason_code && INCOMPATIBLE.has(fresh.reason_code)) setDialog({ status: fresh, wantCli: false });
    },
  });

  return (
    <div className="p-6 pb-12 max-w-[62rem] mx-auto w-full flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <p className="text-xs text-gray-400">
            Checks your semantic models, metrics and saved queries with MetricFlow {status.engine_version} — the same
            validations as <code className="font-mono">mf validate-configs</code>.
          </p>
          <p className="text-[11px] text-gray-500">{statusLine(status)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            disabled={running || !status.can_query}
            onClick={() => run(true)}
            title={status.can_query ? 'Also runs every metric with LIMIT 0 through dbt show' : status.reason ?? ''}
            className="px-2.5 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-brand-600 hover:text-brand-300 disabled:opacity-40 transition-colors"
          >
            Check against warehouse
          </button>
          <RunButton running={running} onClick={() => run(false)} label="Run check" />
        </div>
      </div>

      {status.mode === 'off' && (
        <Notice tone="idle">
          MetricFlow is off {status.mode_source === 'project' ? 'for this project' : 'by default (Global Settings)'}.
          <button onClick={enable} disabled={setMode.isPending} className="ml-2 text-brand-300 hover:text-brand-200 underline-offset-2 hover:underline">
            Enable MetricFlow
          </button>
        </Notice>
      )}
      {status.mode !== 'off' && status.reason_code && INCOMPATIBLE.has(status.reason_code) && (
        <Notice tone="warn">
          {status.reason}
          <button onClick={() => setDialog({ status, wantCli: false })} className="ml-2 text-brand-300 hover:text-brand-200 underline-offset-2 hover:underline">
            Choose a dbt-core version…
          </button>
        </Notice>
      )}
      {status.reason_code === 'unsupported_adapter' && <Notice tone="warn">{status.reason}</Notice>}
      {status.warning && <Notice tone="warn">{status.warning}</Notice>}
      {sidecar && (
        <Notice tone="running">
          <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />
          Setting up MetricFlow (first use, about a minute): {sidecar.message}
        </Notice>
      )}
      {runError && !blocked?.status && <Notice tone="fail">{blocked?.message ?? errorMessage(runError)}</Notice>}
      {summary?.semantic && summary.semantic.stale_reasons.length > 0 && !running && (
        <StaleNotice reasons={summary.semantic.stale_reasons} onRerun={() => run(false)} />
      )}

      {running && (
        <p className="flex items-center gap-2 text-xs text-brand-300"><Loader2 className="w-3.5 h-3.5 animate-spin" />Validating the semantic layer…</p>
      )}
      {check && check.status === 'error' && !running && <Notice tone="fail">{check.error_message ?? 'The check failed.'}</Notice>}
      {check && check.status === 'done' && !running && (
        <>
          <p className="text-[11px] text-gray-600">
            Last checked {check.finished_at ? relativeTime(check.finished_at) : ''}
            {check.results.warehouse ? ' · with warehouse' : ''}
          </p>
          <SemanticIssues projectId={projectId} results={check.results} />
        </>
      )}
      {!check && !running && status.available && <p className="text-xs text-gray-500">Not checked yet. Run the check to validate the semantic layer.</p>}

      {status.available && status.mode !== 'off' && (
        <button
          onClick={() => setDialog({ status, wantCli: true })}
          className="self-start text-[11px] text-gray-500 hover:text-gray-300 underline-offset-2 hover:underline"
        >
          Install the mf CLI into my dbt environment…
        </button>
      )}

      {dialog && <CliAwareDialog projectId={projectId} dialog={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** The dialog needs the status computed for the CLI when installing it. */
function CliAwareDialog({ projectId, dialog, onClose }: { projectId: number; dialog: DialogState; onClose: () => void }) {
  const { data: cliStatus } = useSemanticStatus(projectId, true);
  const status = dialog.wantCli ? cliStatus : dialog.status;
  if (!status) return null;
  return <MetricFlowCompatDialog projectId={projectId} status={status} wantCli={dialog.wantCli} onClose={onClose} />;
}

const NOTICE_CLS = {
  idle: 'bg-surface-elevated/40 border-gray-800 text-gray-300',
  warn: 'bg-amber-950/30 border-amber-900/50 text-amber-200',
  fail: 'bg-red-950/30 border-red-900/50 text-red-300',
  running: 'bg-brand-950/30 border-brand-900/50 text-brand-200',
} as const;

function Notice({ tone, children }: { tone: keyof typeof NOTICE_CLS; children: React.ReactNode }) {
  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs leading-relaxed ${NOTICE_CLS[tone]}`}>
      {tone === 'warn' && <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}
