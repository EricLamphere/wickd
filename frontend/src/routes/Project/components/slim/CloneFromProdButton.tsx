import { useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { alertError, confirmDialog } from '../../../../lib/dialogs';
import { slimApi } from '../../../../lib/slimApi';
import { canClone } from '../../../../lib/slimBuild';

interface CloneFromProdButtonProps {
  projectId: number;
  name: string;
  resourceType: string;
  materialized: string | null | undefined;
}

/** `dbt clone --select <model> --state <dir>`: copy the prod relation into dev (zero-copy where supported). */
export function CloneFromProdButton({ projectId, name, resourceType, materialized }: CloneFromProdButtonProps) {
  const [busy, setBusy] = useState(false);
  if (!canClone(resourceType, materialized)) return null;
  const clone = async () => {
    const ok = await confirmDialog(
      `Clone ${name} from the state manifest's relation (STATE_SOURCE) into your dev schema? `
        + 'Snowflake, BigQuery and Databricks make a zero-copy clone; other adapters create a view. '
        + 'An existing dev relation is kept unless you build with full refresh.',
      { confirmLabel: 'Clone' },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await slimApi.clone(projectId, name);
    } catch (e) {
      alertError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={clone}
      disabled={busy}
      title="dbt clone: copy the production relation into dev before working on this model"
      className="flex items-center justify-center gap-2 w-full py-2 text-sm rounded bg-surface-elevated hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50"
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
      Clone from prod
    </button>
  );
}
