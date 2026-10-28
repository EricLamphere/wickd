// Metrics page → Monitors (Pro): cards per monitor, Check now, the optional interval,
// and one monitor's detail (?monitor=<id>). Checked after builds that touch a monitored
// metric, on Check now, or on the interval — only while wickd is open.
import { useState } from 'react';
import { Activity, Plus, RotateCcw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { api } from '../../../../lib/api';
import type { MonitorCreateBody } from '../../../../lib/monitorsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { UpgradeModal } from '../../components/UpgradeModal';
import { CreateMonitorDialog, type MonitorDraft } from './CreateMonitorDialog';
import { MonitorGrid } from './MonitorGrid';
import { MonitorDetail } from './MonitorDetail';
import { errorText, useMonitorActions, useMonitors } from './useMonitors';

export const MONITOR_PARAM = 'monitor';
const INTERVALS = [null, 1, 3, 6, 12, 24] as const;
const STEP_LABEL: Record<string, string> = {
  starting: 'Starting…', slices: 'Finding top slices…', querying: 'Querying the warehouse…', detecting: 'Scoring…',
};

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  /** pre-filled by "Monitor this metric" in the explorer */
  draft: MonitorDraft | null;
  onDraftHandled: () => void;
}

export function MonitorsTab({ projectId, catalog, draft, onDraftHandled }: Props) {
  const monitors = useMonitors(projectId);
  const actions = useMonitorActions(projectId);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const { data: targets } = useQuery({ queryKey: ['dbt-targets', projectId], queryFn: () => api.profiles.dbtTargets(projectId) });
  const targetNames = targets?.targets ?? [];
  const dialogOpen = creating || draft !== null;

  const selectedId = Number(params.get(MONITOR_PARAM)) || null;
  const select = (id: number | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id === null) next.delete(MONITOR_PARAM); else next.set(MONITOR_PARAM, String(id));
    return next;
  });

  if (monitors.locked) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 h-full px-8 text-center">
        <Activity size={28} className="text-gray-600" />
        <h2 className="text-sm font-semibold text-gray-200">Know when a metric looks wrong</h2>
        <p className="max-w-md text-xs text-gray-500">
          wickd Pro watches your metrics for spikes, drops, level shifts, missing periods and restated history,
          against a seasonal baseline, and tells you after a build whether your change moved them.
        </p>
        <ProFeatureButton onClick={() => setUpgradeOpen(true)}>Unlock metric monitors</ProFeatureButton>
        {upgradeOpen && <UpgradeModal feature="Metric monitors" onClose={() => setUpgradeOpen(false)} />}
      </div>
    );
  }
  if (monitors.unavailable) return <p className="p-6 text-xs text-gray-500">Metric monitors need the wickd Pro package, which isn't in this build.</p>;
  if (monitors.loading) return <p className="p-6 text-xs text-gray-500">Loading monitors…</p>;
  if (!monitors.data) return <p className="p-6 text-xs text-red-400">Couldn't load monitors: {errorText(monitors.error)}</p>;

  const { data } = monitors;
  const create = async (body: MonitorCreateBody) => {
    const created = await actions.create(body);
    if (created) { setCreating(false); onDraftHandled(); select(created.id); }
  };
  const closeDialog = () => { setCreating(false); onDraftHandled(); actions.clearError(); };
  const dialog = dialogOpen && (
    <CreateMonitorDialog catalog={catalog} initial={draft} targets={targetNames} busy={actions.busy}
      error={actions.error} onCreate={create} onClose={closeDialog} />
  );

  const selected = data.monitors.find((m) => m.id === selectedId);
  if (selected) {
    return (
      <>
        <MonitorDetail
          projectId={projectId} monitor={selected} targets={targetNames} running={monitors.running}
          onBack={() => select(null)}
          onUpdate={(body) => actions.update(selected.id, body)}
          onDelete={async () => { await actions.remove(selected.id); select(null); }}
          onRefresh={() => actions.refresh([selected.id])}
          onSuppress={(slice, period, suppressed) => actions.suppress(selected.id, slice, period, suppressed)}
        />
        {dialog}
      </>
    );
  }

  const full = data.monitors.length >= data.max_monitors;
  return (
    <div className="flex flex-col gap-4 p-5 pb-12 max-w-[72rem] mx-auto w-full">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 min-w-[16rem] text-[11px] text-gray-500 leading-relaxed">
          Checked after a build that touches a monitored metric, when you press Check now, or on the interval below,
          and only while wickd is open. This isn't overnight alerting.
        </p>
        <label className="flex items-center gap-2 text-[11px] text-gray-500">
          Auto-check
          <select value={data.interval_hours ?? ''} onChange={(e) => actions.setInterval(e.target.value ? Number(e.target.value) : null)}
            className="px-2 py-1 bg-surface-app border border-gray-700 rounded text-xs text-gray-200">
            {INTERVALS.map((h) => <option key={h ?? 'off'} value={h ?? ''}>{h === null ? 'Off' : `Every ${h} h`}</option>)}
          </select>
        </label>
        <button onClick={() => actions.refresh()} disabled={monitors.running || data.monitors.length === 0}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500 disabled:opacity-40">
          <RotateCcw className={`w-3.5 h-3.5 ${monitors.running ? 'animate-spin' : ''}`} />
          {monitors.running ? STEP_LABEL[monitors.step ?? ''] ?? 'Checking…' : 'Check now'}
        </button>
        <button onClick={() => setCreating(true)} disabled={full} title={full ? `At most ${data.max_monitors} monitors per project` : undefined}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
          <Plus className="w-3.5 h-3.5" />New monitor
        </button>
      </div>
      {actions.error && !dialogOpen && <p className="text-xs text-red-400">{actions.error}</p>}
      {data.last_run?.status === 'error' && <p className="text-xs text-red-400">Last check failed: {data.last_run.error_message}</p>}

      {data.monitors.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Activity size={24} className="text-gray-600" />
          <p className="text-xs text-gray-400">No monitors yet.</p>
          <p className="max-w-sm text-[11px] text-gray-600">Pick a metric and a grain. wickd keeps its history and flags periods that look wrong.</p>
        </div>
      ) : (
        <MonitorGrid monitors={data.monitors} activeTarget={data.active_target} running={monitors.running}
          onOpen={select} onReorder={actions.reorder} />
      )}
      {dialog}
    </div>
  );
}
