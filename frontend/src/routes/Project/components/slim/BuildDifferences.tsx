import { GitCompare } from 'lucide-react';
import type { StatePreviewDto } from '../../../../lib/slimApi';

function Names({ names }: { names: string[] }) {
  return <span className="font-mono text-gray-200">{names.join(', ')}</span>;
}

/** Where dbt's idea of "changed" (vs production) and git's (changed files) differ, and what it means. */
export function BuildDifferences({ preview }: { preview: StatePreviewDto }) {
  if (!preview.dbt_only.length && !preview.git_only.length) return null;
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 rounded border border-gray-800 bg-surface-elevated/40 text-xs text-gray-400">
      <span className="flex items-center gap-1.5 text-gray-300"><GitCompare size={12} />dbt and git see different changes</span>
      {preview.dbt_only.length > 0 && (
        <span>
          <Names names={preview.dbt_only} /> will be built although none of their files changed. dbt sees a difference
          from production: a config, a macro they call, a package, or a <code>dbt_project.yml</code> / vars change.
          If that's not expected, check that <code>STATE_SOURCE</code> points at what prod actually runs.
        </span>
      )}
      {preview.git_only.length > 0 && (
        <span>
          <Names names={preview.git_only} /> changed in git but match production, so dbt won't rebuild them. Nothing to do.
        </span>
      )}
    </div>
  );
}
