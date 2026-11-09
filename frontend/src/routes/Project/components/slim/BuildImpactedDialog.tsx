import { useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Info, Loader2, Play, RefreshCw, X } from 'lucide-react';
import { api } from '../../../../lib/api';
import { apiErrorMessage } from '../../../../lib/slimBuild';
import { useProjectEvents } from '../../../../lib/sse';
import { BuildCommand } from './BuildCommand';
import { BuildConfig, type BuildOptions } from './BuildConfig';
import { BuildDifferences } from './BuildDifferences';
import { BuildNodes, nodeCountsLabel } from './BuildNodes';
import { LoadLineageNotice } from './LoadLineageNotice';
import { useBuildPlan, type ShownBuild } from './useBuildPlan';
import { useSlimSettings } from './useSlimSettings';

interface BuildImpactedDialogProps {
  projectId: number;
  /** the Impact tab's scope (git comparison for the prod source) */
  scope: 'working' | 'branch';
  base: string | null;
  shown: ShownBuild;
  /** what the Impact view shows, in words */
  shownLabel: string;
  /** the build started (the dialog closes right after) */
  onStarted?: () => void;
  onClose: () => void;
}

const SOURCE_KEY = (projectId: number) => `build-source:${projectId}`;

function readSource(projectId: number, fallback: BuildOptions['source']): BuildOptions['source'] {
  try {
    const v = sessionStorage.getItem(SOURCE_KEY(projectId));
    return v === 'prod' || v === 'shown' ? v : fallback;
  } catch { return fallback; }
}

function Section({ title, aside, children, className = '' }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-2.5 min-w-0 ${className}`}>
      <div className="flex items-baseline gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{title}</h3>
        {aside && <span className="text-xs text-gray-500">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function previewedAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

/** Configure a build of the Impact view (or of what changed vs production), see the command and nodes, then run it. */
export function BuildImpactedDialog({ projectId, scope, base, shown, shownLabel, onStarted, onClose }: BuildImpactedDialogProps) {
  const sticky = useSlimSettings(projectId);
  const [options, setOptions] = useState<BuildOptions>(() => ({
    source: shown.selector ? readSource(projectId, 'shown') : 'prod',
    method: 'state:modified', downstream: true, prune: false, defer: sticky.defer,
  }));
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const plan = useBuildPlan(projectId, options, shown, scope, base);

  const change = (next: BuildOptions) => {
    setOptions(next);
    try { sessionStorage.setItem(SOURCE_KEY(projectId), next.source); } catch { /* per-session convenience only */ }
  };

  // after Load column lineage, preview again so the smallest safe set can prune
  const lineageNeeded = !!plan.preview?.lineage_needed;
  const { refresh } = plan;
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'column_lineage_finished' && lineageNeeded) refresh?.();
  }, [lineageNeeded, refresh]));

  const run = async () => {
    if (!plan.request) return;
    setRunning(true);
    setRunError(null);
    try {
      await api.runs.build(projectId, '', 'only', plan.request.opts, plan.request.select);
      onStarted?.();
      onClose();
    } catch (err) {
      setRunError(apiErrorMessage(err, 'Failed to start the build'));
    } finally {
      setRunning(false);
    }
  };

  const notes = [...(plan.preview?.state.notes ?? []), ...(plan.preview?.notes ?? [])]
    .filter((n) => !(lineageNeeded && n.startsWith('Column lineage is missing')));

  // portalled to <body>: inside the bottom pane, `fixed` is sized and clipped by the pane, not the window
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Build impacted"
        className="flex flex-col w-full max-w-[1600px] h-full max-h-[94vh] overflow-hidden bg-surface-panel border border-gray-700 rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold text-gray-200">Build impacted</h2>
            <span className="text-[11px] text-gray-500">Configure the build and check the command and nodes. Nothing runs until you click Run build.</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300" aria-label="Close"><X size={14} /></button>
        </div>

        <div className="grid grid-cols-[400px_minmax(0,1fr)] flex-1 min-h-0">
          <div className="overflow-y-auto px-5 py-4 border-r border-gray-800">
            <Section title="Configuration">
              <BuildConfig value={options} onChange={change} shownLabel={shownLabel} shownEmpty={!shown.selector} />
            </Section>
          </div>

          <div className="flex flex-col gap-5 min-w-0 min-h-0 overflow-hidden px-5 py-4">
            <Section title="Command">
              <BuildCommand command={plan.loading ? null : plan.command}
                note={options.source === 'prod' && plan.preview ? `Compared with ${plan.preview.state.kind === 'path' ? plan.preview.state.folder : `${plan.preview.state.ref} @ ${plan.preview.state.sha}`}.` : undefined} />
              {notes.map((note) => (
                <p key={note} className="flex items-start gap-1.5 text-xs text-amber-300">
                  {note.includes("isn't set") ? <AlertTriangle size={12} className="mt-0.5 shrink-0" /> : <Info size={12} className="mt-0.5 shrink-0" />}
                  {note}
                </p>
              ))}
              {lineageNeeded && <LoadLineageNotice projectId={projectId} />}
              {plan.preview && <BuildDifferences preview={plan.preview} />}
            </Section>

            <Section title="Nodes" aside={plan.loading ? undefined : nodeCountsLabel(plan.counts)} className="flex-1 min-h-0">
              <div className="flex-1 min-w-0 min-h-0 overflow-auto border border-gray-800 rounded">
                {plan.loading && (
                  <div className="flex items-center justify-center gap-2 h-full py-10 text-xs text-gray-500">
                    <Loader2 size={14} className="animate-spin" />
                    {options.prune ? 'Asking dbt, comparing both sides and walking column lineage…' : 'Asking dbt what changed…'}
                  </div>
                )}
                {!plan.loading && plan.error && <p className="px-3 py-6 text-xs text-red-400 whitespace-pre-wrap">{plan.error}</p>}
                {!plan.loading && !plan.error && (
                  <BuildNodes rows={plan.rows} empty={options.source === 'prod' ? 'dbt sees no difference from production.' : 'Nothing to build.'} />
                )}
              </div>
            </Section>
          </div>
        </div>

        <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-800">
          {plan.refresh && plan.preview && !plan.loading && (
            <span className="flex items-center gap-2 text-[11px] text-gray-500 whitespace-nowrap">
              Previewed {previewedAgo(plan.previewedAt)}
              <button onClick={plan.refresh} title="Ask dbt again"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-gray-400 hover:bg-gray-800 hover:text-gray-200">
                <RefreshCw size={11} /> Refresh
              </button>
            </span>
          )}
          {runError && <span className="text-xs text-red-400 truncate">{runError}</span>}
          <button onClick={onClose} className="ml-auto px-3 py-1.5 text-xs rounded text-gray-400 hover:bg-gray-800 hover:text-gray-200">Cancel</button>
          <button onClick={run} disabled={running || plan.loading || !plan.request}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white font-medium hover:bg-brand-500 disabled:opacity-40">
            {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Run build
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
