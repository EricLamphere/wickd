import { useMemo, useState } from 'react';
import { PanelTopOpen } from 'lucide-react';
import { totalImpactTests, type Impact } from '../../lib/impact';
import type { ImpactMode } from '../../lib/impactChanges';
import { BuildImpactedDialog } from './BuildImpactedDialog';
import { rowsFromImpact } from './buildRows';
import { markBuildForDiff } from '../../lib/buildNudge';

interface ImpactBuildButtonProps {
  projectId: number;
  mode: ImpactMode;
  /** Branch mode's base ref (to compare dbt's view of the change with git's) */
  base: string | null;
  /** the --select of what the Impact table shows ('' = nothing buildable) */
  selector: string;
  impact: Impact | null;
  /** column-level impact is narrowing the table */
  columnLevel: boolean;
}

function shownLabel(mode: ImpactMode, columnLevel: boolean): string {
  if (mode === 'working') return 'Your uncommitted changes';
  if (mode === 'branch') return 'Everything changed on this branch';
  return columnLevel ? 'The nodes your selected columns reach' : 'The selected nodes';
}

/** The Impact tab's Build impacted…: opens the build dialog; never runs anything by itself. */
export function ImpactBuildButton({ projectId, mode, base, selector, impact, columnLevel }: ImpactBuildButtonProps) {
  const [open, setOpen] = useState(false);
  const changeMode = mode !== 'selection';
  const shown = useMemo(() => ({
    selector,
    rows: rowsFromImpact(impact, changeMode),
    tests: impact ? totalImpactTests(impact.summary) : 0,
  }), [selector, impact, changeMode]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Opens the build dialog: choose what to build, see the exact dbt command and the nodes, then run it"
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-brand-800 bg-brand-900/40 text-brand-300 transition-colors hover:bg-brand-800/60"
      >
        <PanelTopOpen size={12} />
        Build impacted…
      </button>
      {open && (
        <BuildImpactedDialog
          projectId={projectId}
          scope={mode === 'branch' ? 'branch' : 'working'}
          base={base}
          shown={shown}
          shownLabel={shownLabel(mode, columnLevel)}
          // in Uncommitted / Branch, a finished build offers to data diff the changed models
          onStarted={changeMode ? () => markBuildForDiff(projectId) : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
