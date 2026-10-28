// Inline notice when something needs MetricFlow but it can't run here: Enable (when off)
// or pick a compatible dbt-core (plan 07's dialog). Used by Wicky's semantic drafts.
import { useState } from 'react';
import type { SemanticStatusDto } from '../../../../lib/semanticApi';
import { MetricFlowCompatDialog } from './MetricFlowCompatDialog';
import { INCOMPATIBLE_REASONS } from './semanticView';
import { useSetMetricflowMode } from './useSemantic';

const LINK = 'ml-1.5 text-brand-300 hover:text-brand-200 underline-offset-2 hover:underline';

export function MetricflowBlockedNotice({ projectId, status, onResolved }: {
  projectId: number;
  status: SemanticStatusDto;
  /** MetricFlow was enabled (or the dialog closed): the caller may retry. */
  onResolved: () => void;
}) {
  const setMode = useSetMetricflowMode(projectId);
  const [dialog, setDialog] = useState(false);
  const incompatible = !!status.reason_code && INCOMPATIBLE_REASONS.has(status.reason_code);
  return (
    <span className="text-amber-300 break-words">
      {status.mode === 'off' ? 'MetricFlow is off, and drafts are checked with it.' : status.reason}
      {status.mode === 'off' && (
        <button className={LINK} disabled={setMode.isPending} onClick={() => setMode.mutate('auto', { onSuccess: onResolved })}>
          Enable MetricFlow
        </button>
      )}
      {status.mode !== 'off' && incompatible && (
        <button className={LINK} onClick={() => setDialog(true)}>Choose a dbt-core version…</button>
      )}
      {dialog && (
        <MetricFlowCompatDialog projectId={projectId} status={status} onClose={() => { setDialog(false); onResolved(); }} />
      )}
    </span>
  );
}
