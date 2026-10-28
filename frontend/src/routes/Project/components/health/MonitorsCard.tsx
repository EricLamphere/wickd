import { AlertTriangle, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { CheckSummary } from '../../../../lib/api';
import { relativeTime } from '../../lib/relativeTime';
import { useMonitorActions } from '../../Metrics/monitors/useMonitors';
import { TONE_DOT, TONE_TEXT, toneFor } from './healthStatus';
import { ProLabel } from '../../../../components/ProLabel';
import RunButton from './RunButton';
import Spinner from './Spinner';

/** Health overview card for metric monitors (Pro); opens Metrics → Monitors. Shown only when the project has monitors. */
export default function MonitorsCard({ projectId, check }: { projectId: number; check: CheckSummary }) {
  const navigate = useNavigate();
  const actions = useMonitorActions(projectId);
  const running = actions.busy || check.status === 'running';
  const tone = running ? 'running' : toneFor(check.status);

  return (
    <div className="flex flex-col bg-surface-panel border border-gray-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => navigate(`/projects/${projectId}/metrics?tab=monitors`)}
        className="group flex-1 flex flex-col gap-2 px-4 pt-4 pb-3 text-left hover:bg-surface-elevated/30 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${TONE_DOT[tone]}`} />
          <ProLabel className="flex-1 text-sm font-semibold text-gray-100">Metric Monitors</ProLabel>
          <ChevronRight className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-300 transition-colors" />
        </span>
        <span className={`flex items-center gap-1.5 text-xs ${TONE_TEXT[tone]}`}>
          {running && <Spinner className="w-3 h-3" />}
          {check.headline}
        </span>
        <span className="text-[11px] text-gray-600 leading-relaxed">
          Spikes, drops, level shifts, missing periods and restated history in monitored metrics
        </span>
        {check.stale_reasons.length > 0 && !running && (
          <span className="flex items-start gap-1.5 text-[11px] text-amber-400/90">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            {check.stale_reasons.join(' · ')}
          </span>
        )}
        {actions.error && <span className="text-[11px] text-red-400 break-words">{actions.error}</span>}
      </button>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-gray-800">
        <span className="text-[10px] text-gray-600 truncate">
          {check.finished_at ? `Checked ${relativeTime(check.finished_at)}` : 'Never checked'} · only while wickd is open
        </span>
        <RunButton running={running} onClick={() => actions.refresh()} label="Check now" />
      </div>
    </div>
  );
}
