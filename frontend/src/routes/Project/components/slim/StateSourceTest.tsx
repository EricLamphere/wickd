import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { alertDialog } from '../../../../lib/dialogs';
import { slimApi } from '../../../../lib/slimApi';
import { apiErrorMessage } from '../../../../lib/slimBuild';

/** Environment → STATE_SOURCE "Test": resolve the state manifest and say what was found. */
export function StateSourceTest({ projectId }: { projectId: number }) {
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true);
    try {
      const s = await slimApi.state(projectId);
      const where = s.kind === 'path' ? s.folder : `${s.ref} @ ${s.sha}${s.target ? ` (parsed for ${s.target})` : ''}`;
      const lines = [`State manifest found: ${where}`, `dbt ${s.dbt_version ?? '?'}, generated ${s.generated_at ?? 'at an unknown time'}`, ...s.notes];
      await alertDialog(lines.join('\n\n'));
    } catch (err) {
      await alertDialog(apiErrorMessage(err, "Couldn't resolve STATE_SOURCE"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button onClick={test} disabled={busy} className="flex items-center gap-1 px-1.5 text-[11px] text-brand-400 hover:text-brand-300 disabled:opacity-50 shrink-0">
      {busy && <Loader2 size={11} className="animate-spin" />}
      Test
    </button>
  );
}
